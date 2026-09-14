import { Effect, Stream } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { PdfError, pdfLimits } from "../shared/pdf.ts";

const downloadError = () =>
  new PdfError({
    code: "pdf_unavailable",
    message:
      "Could not retrieve this PDF. Its URL may be revoked, expired, or inaccessible to the extension.",
  });

export const downloadPdf = Effect.fn("Pdf.download")(
  function* (url: string) {
    const response = yield* HttpClient.get(url).pipe(Effect.mapError(downloadError));

    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new PdfError({
          code: "pdf_unavailable",
          message: `PDF retrieval returned HTTP ${response.status}. The link may have expired or require authentication.`,
        }),
      );
    }

    return yield* response.stream.pipe(
      Stream.mapError(downloadError),
      Stream.limitBytes(pdfLimits.downloadBytes, () =>
        Stream.fail(
          new PdfError({
            code: "pdf_too_large",
            message: `This PDF exceeds the ${pdfLimits.downloadBytes / (1024 * 1024)} MiB download limit.`,
          }),
        ),
      ),
      Stream.mkUint8Array,
    );
  },
  Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }),
);
