import init, { detectPdf, processPdf } from "@firecrawl/pdf-inspector-wasm";
import { Cache, Effect, Layer } from "effect";
import { BrowserWorkerRunner } from "@effect/platform-browser";
import { RpcServer } from "effect/unstable/rpc";
import { FetchHttpClient } from "effect/unstable/http";
import { downloadPdf } from "./pdf-download.ts";
import { PdfError, PdfWorkerRpc, pdfLimits } from "../shared/pdf.ts";

// Each worker instance owns exactly one document and its extracted batches.
// The parent serializes requests; opening resets all state for that document.

const parserError = (cause: unknown) => {
  const encrypted = String(cause).includes("encrypted");

  return new PdfError({
    code: encrypted ? "pdf_password_required" : "pdf_extraction_failed",
    message: encrypted
      ? "This PDF requires a password. Unlocking Chrome's viewer does not unlock this reader."
      : "Could not extract this PDF. The file may be malformed or unsupported.",
  });
};

const handlers = PdfWorkerRpc.toLayer(
  Effect.gen(function* () {
    const initialized = yield* Effect.cached(
      Effect.tryPromise({ try: () => init(), catch: parserError }),
    );

    let bytes: Uint8Array | undefined;
    let ocrPages = new Set<number>();
    let pageCount = 0;

    const extracted = yield* Cache.make({
      capacity: pdfLimits.cachedBatches,
      lookup: Effect.fn("PdfWorker.extract")((key: string) =>
        Effect.gen(function* () {
          const input = bytes;

          if (!input)
            return yield* Effect.fail(
              new PdfError({
                code: "pdf_document_expired",
                message: "Open the PDF again before reading it.",
              }),
            );
          const pages = key.split(",").map(Number);

          const result = yield* Effect.try({
            try: () => processPdf(input, { pages, profile: "fidelity", includePageMarkers: true }),
            catch: parserError,
          });

          const text = result.markdown ?? "";

          if (text.length > pdfLimits.batchText)
            return yield* Effect.fail(
              new PdfError({
                code: "pdf_too_large",
                message:
                  "This page batch exceeds the extraction memory limit. Open the PDF again and request fewer pages.",
              }),
            );

          // Selected-page sparse-output heuristics can flag the entire book. Use the
          // initial detection and specific page reasons instead of that global flag.
          const recommended = pages.filter(
            (page) =>
              ocrPages.has(page) || result.ocrReasonsByPage.some((reason) => reason.page === page),
          );

          const warnings =
            recommended.length > 0
              ? [
                  {
                    pages: recommended,
                    message: "These pages may require OCR; extracted text may be incomplete.",
                  },
                ]
              : [];

          if (!text.trim())
            warnings.push({
              pages,
              message:
                "No extractable text was found in these pages. They may be blank or require OCR.",
            });

          return { text, warnings };
        }),
      ),
    });

    return {
      Open: Effect.fn("PdfWorker.open")(function* ({ url }) {
        yield* initialized;
        const loaded = yield* downloadPdf(url);
        const result = yield* Effect.try({ try: () => detectPdf(loaded), catch: parserError });
        bytes = loaded;
        pageCount = result.pageCount;
        ocrPages = new Set(result.pagesNeedingOcr);
        yield* Cache.invalidateAll(extracted);

        return { pageCount };
      }),
      Extract: Effect.fn("PdfWorker.read")(function* ({ pages }) {
        if (pages.some((page) => page > pageCount)) {
          return yield* Effect.fail(
            new PdfError({
              code: "pdf_pages_invalid",
              message: `This PDF has ${pageCount} physical pages.`,
            }),
          );
        }

        return yield* Cache.get(extracted, pages.join(","));
      }),
    };
  }),
);

const transport = RpcServer.layerProtocolWorkerRunner.pipe(
  Layer.provide(BrowserWorkerRunner.layer),
);

Effect.runFork(
  RpcServer.layer(PdfWorkerRpc, { concurrency: 1 }).pipe(
    Layer.provide(handlers),
    Layer.provide(transport),
    Layer.provide(FetchHttpClient.layer),
    Layer.launch,
  ),
);
