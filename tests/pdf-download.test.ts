import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { downloadPdf } from "../extension/pdf-download.ts";
import { pdfLimits } from "../shared/pdf.ts";

it.effect("rejects an oversized PDF and cancels the remaining download", () =>
  Effect.gen(function* () {
    const chunk = new Uint8Array(1024 * 1024);
    let received = 0;
    let cancelled = false;

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        received += chunk.byteLength;
        controller.enqueue(chunk);

        if (received > pdfLimits.downloadBytes + 2 * chunk.byteLength) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });

    const outcome = yield* downloadPdf("https://example.com/book.pdf").pipe(
      Effect.result,
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, () => Promise.resolve(new Response(body))),
    );

    if (Result.isSuccess(outcome)) throw new Error("Oversized PDF download succeeded");
    expect(outcome.failure.code).toBe("pdf_too_large");
    expect(cancelled).toBe(true);
  }),
);
