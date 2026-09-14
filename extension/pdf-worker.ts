import init, { detectPdf, processPdf } from "@firecrawl/pdf-inspector-wasm";
import { Cache, Effect, Schema } from "effect";
import { PdfError, PdfWorkerReply, PdfWorkerRequest, pdfLimits } from "../shared/pdf.ts";

// Each worker instance owns exactly one document and its extracted batches.
// The parent serializes requests; opening resets all state for that document.

const load = Effect.fn("PdfWorker.load")((url: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { credentials: "include", signal });

      if (!response.ok)
        throw new PdfError({
          code: "pdf_unavailable",
          message: `PDF retrieval returned HTTP ${response.status}. The link may have expired or require authentication.`,
        });
      const reader = response.body?.getReader();

      if (!reader)
        throw new PdfError({ code: "pdf_unavailable", message: "The PDF response has no body." });
      const chunks: Uint8Array[] = [];
      let length = 0;

      try {
        while (true) {
          const chunk = await reader.read();

          if (chunk.done) break;
          length += chunk.value.byteLength;

          if (length > pdfLimits.downloadBytes)
            throw new PdfError({
              code: "pdf_too_large",
              message: `This PDF exceeds the ${pdfLimits.downloadBytes / (1024 * 1024)} MiB download limit.`,
            });
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }

      const bytes = new Uint8Array(length);
      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return bytes;
    },
    catch: (cause) =>
      cause instanceof PdfError
        ? cause
        : new PdfError({
            code: "pdf_unavailable",
            message:
              "Could not retrieve this PDF. Its URL may be revoked, expired, or inaccessible to the extension.",
          }),
  }),
);

const parserError = (cause: unknown) => {
  const encrypted = String(cause).includes("encrypted");

  return new PdfError({
    code: encrypted ? "pdf_password_required" : "pdf_extraction_failed",
    message: encrypted
      ? "This PDF requires a password. Unlocking Chrome's viewer does not unlock this reader."
      : "Could not extract this PDF. The file may be malformed or unsupported.",
  });
};

const program = Effect.gen(function* () {
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

        return PdfWorkerReply.cases.Extracted.make({ text, warnings });
      }),
    ),
  });

  const handle = Effect.fn("PdfWorker.handle")(function* (request: PdfWorkerRequest) {
    return yield* PdfWorkerRequest.match(request, {
      Open: ({ url }): Effect.Effect<PdfWorkerReply, PdfError> =>
        Effect.gen(function* () {
          yield* initialized;
          const loaded = yield* load(url);
          bytes = loaded;
          const result = yield* Effect.try({ try: () => detectPdf(loaded), catch: parserError });
          pageCount = result.pageCount;
          ocrPages = new Set(result.pagesNeedingOcr);
          yield* Cache.invalidateAll(extracted);

          return PdfWorkerReply.cases.Opened.make({ pageCount });
        }),
      Extract: ({ pages }) =>
        Effect.gen(function* () {
          if (pages.some((page) => page > pageCount))
            return yield* Effect.fail(
              new PdfError({
                code: "pdf_pages_invalid",
                message: `This PDF has ${pageCount} physical pages.`,
              }),
            );

          return yield* Cache.get(extracted, pages.join(","));
        }),
    });
  });

  self.addEventListener("message", (event: MessageEvent) => {
    const reply = Schema.decodeUnknownEffect(PdfWorkerRequest)(event.data).pipe(
      Effect.mapError(
        () =>
          new PdfError({ code: "pdf_extraction_failed", message: "Invalid PDF worker request." }),
      ),
      Effect.flatMap(handle),
      Effect.catchTag("PdfError", ({ code, message }) =>
        Effect.succeed(PdfWorkerReply.cases.Failed.make({ code, message })),
      ),
      Effect.catchDefect(() =>
        Effect.succeed(
          PdfWorkerReply.cases.Failed.make({
            code: "pdf_extraction_failed",
            message: "PDF extraction failed unexpectedly. Open the PDF again.",
          }),
        ),
      ),
      Effect.tap((value) => Effect.sync(() => self.postMessage(value))),
    );

    Effect.runFork(reply);
  });
});

Effect.runFork(program);
