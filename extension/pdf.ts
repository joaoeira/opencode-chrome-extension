import { BrowserWorker } from "@effect/platform-browser";
import { RpcClient, type RpcClientError } from "effect/unstable/rpc";
import {
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Schema,
  Schedule,
  ScopedCache,
  Semaphore,
} from "effect";
import {
  pdfLimits,
  pdfWorkerTimeoutMs,
  pdfOperationTimeoutMs,
  PdfDocument,
  PdfDocumentId,
  PdfError,
  PdfText,
  PdfWorkerRpc,
  type ReadPdfDocumentInput,
} from "../shared/pdf.ts";

import { encodeCursor, positionFor, selectBatch, sliceText } from "./pdf-pagination.ts";

const PdfSource = Schema.Struct({
  tabId: Schema.Int,
  windowId: Schema.Int,
  chromeDocumentId: Schema.String,
  url: Schema.String,
  title: Schema.String,
});

export interface PdfSource extends Schema.Schema.Type<typeof PdfSource> {}

interface DocumentKey extends PdfSource {
  readonly documentId: PdfDocumentId;
  readonly sessionId: string;
}

export const withPdfDeadline = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: pdfOperationTimeoutMs,
      orElse: () =>
        Effect.fail(
          new PdfError({
            code: "pdf_extraction_failed",
            message: "The PDF read timed out. Open the PDF again and request fewer pages.",
          }),
        ),
    }),
  );

const expired = () =>
  new PdfError({
    code: "pdf_document_expired",
    message: "This PDF is no longer available. Use browser_read_pdf with its tabId again.",
  });

const makeDocument = Effect.fn("PdfDocuments.acquire")(function* (source: DocumentKey) {
  const worker = yield* Effect.acquireRelease(
    Effect.sync(() => new Worker(chrome.runtime.getURL("pdf-worker.js"), { type: "module" })),
    (worker) => Effect.sync(() => worker.terminate()),
  );

  const transport = yield* Layer.build(
    RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(
      Layer.provide(BrowserWorker.layer(() => worker)),
    ),
  ).pipe(
    Effect.mapError(
      () =>
        new PdfError({
          code: "pdf_extraction_failed",
          message: "Could not start the PDF worker. Open the PDF again.",
        }),
    ),
  );

  const client = yield* RpcClient.make(PdfWorkerRpc).pipe(Effect.provideContext(transport));

  const call = <A>(request: Effect.Effect<A, PdfError | RpcClientError.RpcClientError>) =>
    request.pipe(
      Effect.catchTag("RpcClientError", () =>
        Effect.fail(
          new PdfError({
            code: "pdf_extraction_failed",
            message: "The PDF worker stopped unexpectedly. Open the PDF again.",
          }),
        ),
      ),
      Effect.timeoutOrElse({
        duration: pdfWorkerTimeoutMs,
        orElse: () =>
          Effect.fail(
            new PdfError({
              code: "pdf_extraction_failed",
              message: "PDF processing timed out. Open the PDF again and request fewer pages.",
            }),
          ),
      }),
      // RPC interruption cannot preempt synchronous WASM. Terminate the actual worker.
      Effect.onError(() => Effect.sync(() => worker.terminate())),
    );

  const opened = yield* call(client.Open({ url: source.url }));

  const metadata = PdfDocument.make({
    type: "pdf",
    documentId: source.documentId,
    tabId: source.tabId,
    url: source.url,
    title: source.title,
    pageCount: opened.pageCount,
  });

  return {
    metadata,
    extract: Effect.fn("PdfDocuments.extract")((pages: ReadonlyArray<number>) =>
      call(client.Extract({ pages })),
    ),
  };
});

interface Interface {
  readonly open: (sessionId: string, source: PdfSource) => Effect.Effect<PdfDocument, PdfError>;
  readonly read: (
    sessionId: string,
    input: ReadPdfDocumentInput,
  ) => Effect.Effect<PdfText, PdfError>;
  readonly readTab: (
    sessionId: string,
    source: PdfSource,
    pages?: ReadPdfDocumentInput["pages"],
  ) => Effect.Effect<PdfText, PdfError>;
  readonly forgetSessionDocuments: Effect.Effect<void>;
}

export class PdfDocuments extends Context.Service<PdfDocuments, Interface>()("PdfDocuments") {}

export const pdfLayer = Layer.effect(
  PdfDocuments,
  Effect.gen(function* () {
    const documents = yield* ScopedCache.make({
      capacity: pdfLimits.documents,
      timeToLive: pdfLimits.documentTtlMs,
      lookup: makeDocument,
    });

    // Serialize heavy parses across documents, not the connection heartbeat.
    const parsing = yield* Semaphore.make(1);
    // keys evicts entries and closes workers. Sweep between reads: getOption
    // does not lease the worker, so expiry must not terminate an active parse.
    yield* ScopedCache.keys(documents).pipe(
      parsing.withPermits(1),
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.forkScoped,
    );

    const validateSource = Effect.fn("PdfDocuments.validateSource")((source: DocumentKey) =>
      Effect.tryPromise({
        try: async () => {
          const tab = await chrome.tabs.get(source.tabId);

          if (tab.windowId !== source.windowId || tab.url !== source.url)
            throw new Error("Moved or navigated tab");

          const [probe] = await chrome.scripting.executeScript({
            target: { tabId: source.tabId },
            func: () => document.contentType,
          });

          if (probe?.documentId !== source.chromeDocumentId || probe.result !== "application/pdf")
            throw new Error("Changed document");
        },
        catch: () =>
          new PdfError({
            code: "pdf_document_changed",
            message:
              "The source PDF tab was closed, moved, or navigated. Use browser_read_pdf with its tabId to open its current document.",
          }),
      }),
    );

    const requireSource = (key: DocumentKey) =>
      validateSource(key).pipe(Effect.onError(() => ScopedCache.invalidate(documents, key)));

    const findDocument = Effect.fn("PdfDocuments.find")(function* (
      sessionId: string,
      documentId: PdfDocumentId,
    ) {
      const keys = yield* ScopedCache.keys(documents);
      const key = keys.find((key) => key.documentId === documentId && key.sessionId === sessionId);

      if (!key) return yield* Effect.fail(expired());
      const document = yield* ScopedCache.getOption(documents, key);

      if (Option.isNone(document)) return yield* Effect.fail(expired());

      return { key, document: document.value };
    });

    const openSnapshot = Effect.fn("PdfDocuments.openSnapshot")(function* (
      sessionId: string,
      source: PdfSource,
    ) {
      const keys = yield* ScopedCache.keys(documents);

      const existing = keys.find(
        (key) =>
          key.sessionId === sessionId &&
          key.tabId === source.tabId &&
          key.windowId === source.windowId &&
          key.chromeDocumentId === source.chromeDocumentId &&
          key.url === source.url,
      );

      if (existing) {
        const document = yield* ScopedCache.getOption(documents, existing);

        if (Option.isSome(document)) {
          yield* requireSource(existing);

          return document.value.metadata;
        }
      }

      const key = new Data.Class<DocumentKey>({
        ...source,
        sessionId,
        documentId: PdfDocumentId.make(crypto.randomUUID()),
      });

      const document = yield* ScopedCache.get(documents, key).pipe(
        Effect.onError(() => ScopedCache.invalidate(documents, key)),
      );

      yield* requireSource(key);

      return document.metadata;
    });

    const readSnapshot = Effect.fn("PdfDocuments.readSnapshot")(function* (
      sessionId: string,
      input: ReadPdfDocumentInput,
    ) {
      const position = yield* positionFor(input);
      const { key, document } = yield* findDocument(sessionId, input.documentId);
      yield* requireSource(key);
      const { pageCount } = document.metadata;
      const { pages, count } = yield* selectBatch(position, pageCount);

      const reply = yield* document
        .extract(pages)
        .pipe(Effect.onError(() => ScopedCache.invalidate(documents, key)));

      const portion = yield* sliceText(reply.text, position.offset);
      const end = portion.end;

      const next =
        end < reply.text.length
          ? { ...position, offset: end }
          : { ...position, index: position.index + pages.length, offset: 0 };

      // The source must remain unchanged for the entire read, including extraction.
      yield* requireSource(key);

      const result = {
        documentId: input.documentId,
        tabId: key.tabId,
        title: key.title,
        url: key.url,
        pageCount,
        pages,
        text: portion.text,
        nextCursor: next.index < count ? encodeCursor(next) : null,
      };

      return PdfText.make(reply.warnings.length ? { ...result, warnings: reply.warnings } : result);
    });

    // Queueing time counts against the bridge deadline, so time the permit wait too.
    const run = <A>(effect: Effect.Effect<A, PdfError>) =>
      effect.pipe(parsing.withPermits(1), withPdfDeadline, Effect.scoped);

    return PdfDocuments.of({
      forgetSessionDocuments: ScopedCache.invalidateAll(documents),
      open: Effect.fn("PdfDocuments.open")(openSnapshot, run),
      read: Effect.fn("PdfDocuments.read")(readSnapshot, run),
      readTab: Effect.fn("PdfDocuments.readTab")(function* (sessionId, source, pages) {
        // Hold the permit through acquisition and first read so another open cannot
        // evict this snapshot between those steps.
        const document = yield* openSnapshot(sessionId, source);
        const request = { documentId: document.documentId };

        return yield* readSnapshot(sessionId, pages ? { ...request, pages } : request);
      }, run),
    });
  }),
);
