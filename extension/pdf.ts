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
  PdfWorkerReply,
  PdfWorkerRequest,
  type ReadPdfInput,
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

const protocolError = () =>
  new PdfError({
    code: "pdf_extraction_failed",
    message: "The PDF worker returned an unexpected reply. Open the PDF again.",
  });

// Apply outside parsing.withPermits: queueing time counts against the bridge deadline.
const withPdfDeadline = <A, R>(effect: Effect.Effect<A, PdfError, R>) =>
  effect.pipe(
    Effect.timeout(pdfOperationTimeoutMs),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new PdfError({
          code: "pdf_extraction_failed",
          message: "The PDF read timed out. Open the PDF again and request fewer pages.",
        }),
      ),
    ),
  );

const expired = () =>
  new PdfError({
    code: "pdf_document_expired",
    message: "This PDF is no longer available. Use browser_read_page on its tab again.",
  });

const makeDocument = Effect.fn("PdfDocuments.acquire")(function* (source: DocumentKey) {
  const worker = yield* Effect.acquireRelease(
    Effect.sync(() => new Worker(chrome.runtime.getURL("pdf-worker.js"), { type: "module" })),
    (worker) => Effect.sync(() => worker.terminate()),
  );

  // The worker protocol has one reply channel; serialize requests at its owner.
  const requests = yield* Semaphore.make(1);
  let alive = true;

  const ask = Effect.fn("PdfDocuments.ask")((request: PdfWorkerRequest) =>
    Effect.callback<PdfWorkerReply, PdfError>((resume) => {
      if (!alive) {
        resume(Effect.fail(expired()));

        return;
      }

      const message = (event: MessageEvent) =>
        resume(
          Schema.decodeUnknownEffect(PdfWorkerReply)(event.data).pipe(
            Effect.mapError(
              () =>
                new PdfError({
                  code: "pdf_extraction_failed",
                  message: "The PDF worker returned an invalid result.",
                }),
            ),
          ),
        );

      const error = () =>
        resume(
          Effect.fail(
            new PdfError({
              code: "pdf_extraction_failed",
              message: "The PDF worker stopped unexpectedly. Open the PDF again.",
            }),
          ),
        );

      worker.addEventListener("message", message);
      worker.addEventListener("error", error);
      worker.postMessage(request);

      return Effect.sync(() => {
        worker.removeEventListener("message", message);
        worker.removeEventListener("error", error);
      });
    }).pipe(
      Effect.timeout(pdfWorkerTimeoutMs),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new PdfError({
            code: "pdf_extraction_failed",
            message: `PDF processing exceeded ${pdfWorkerTimeoutMs / 1000} seconds. Open the PDF again and request fewer pages.`,
          }),
        ),
      ),
      Effect.onError(() =>
        Effect.sync(() => {
          alive = false;
          worker.terminate();
        }),
      ),
      Effect.flatMap((reply) =>
        PdfWorkerReply.guards.Failed(reply)
          ? Effect.fail(new PdfError({ code: reply.code, message: reply.message }))
          : Effect.succeed(reply),
      ),
      requests.withPermits(1),
    ),
  );

  const opened = yield* ask(PdfWorkerRequest.cases.Open.make({ url: source.url }));

  if (!PdfWorkerReply.guards.Opened(opened)) return yield* Effect.fail(protocolError());

  const metadata = PdfDocument.make({
    type: "pdf",
    documentId: source.documentId,
    tabId: source.tabId,
    url: source.url,
    title: source.title,
    pageCount: opened.pageCount,
  });

  return { metadata, ask };
});

interface Interface {
  readonly open: (sessionId: string, source: PdfSource) => Effect.Effect<PdfDocument, PdfError>;
  readonly read: (sessionId: string, input: ReadPdfInput) => Effect.Effect<PdfText, PdfError>;
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
              "The source PDF tab was closed, moved, or navigated. Use browser_read_page to open its current document.",
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

    return PdfDocuments.of({
      forgetSessionDocuments: ScopedCache.invalidateAll(documents),
      open: Effect.fn("PdfDocuments.open")(
        function* (sessionId, source) {
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
        },
        parsing.withPermits(1),
        withPdfDeadline,
        Effect.scoped,
      ),
      read: Effect.fn("PdfDocuments.read")(
        function* (sessionId, input) {
          const position = yield* positionFor(input);
          const { key, document } = yield* findDocument(sessionId, input.documentId);
          yield* requireSource(key);
          const { pageCount } = document.metadata;
          const { pages, count } = yield* selectBatch(position, pageCount);

          const reply = yield* document
            .ask(PdfWorkerRequest.cases.Extract.make({ pages }))
            .pipe(Effect.onError(() => ScopedCache.invalidate(documents, key)));

          if (!PdfWorkerReply.guards.Extracted(reply)) return yield* Effect.fail(protocolError());
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

          return PdfText.make(
            reply.warnings.length ? { ...result, warnings: reply.warnings } : result,
          );
        },
        parsing.withPermits(1),
        withPdfDeadline,
        Effect.scoped,
      ),
    });
  }),
);
