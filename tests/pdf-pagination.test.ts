import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { encodeCursor, positionFor, sliceText } from "../extension/pdf-pagination.ts";
import { PdfDocumentId, pdfLimits } from "../shared/pdf.ts";

it.effect("delivers a character crossing the response boundary intact in one portion", () =>
  Effect.gen(function* () {
    const text = "x".repeat(pdfLimits.responseText - 1) + "🧠 Remaining text.";
    const first = yield* sliceText(text, 0);
    const second = yield* sliceText(text, first.end);

    for (const portion of [first, second]) {
      expect(portion.text.length).toBeLessThanOrEqual(pdfLimits.responseText);
      expect(portion.text).not.toMatch(/\p{Surrogate}/u);
    }

    expect(first.text + second.text).toBe(text);
  }),
);

it.effect("rejects a continuation token issued for another PDF", () =>
  Effect.gen(function* () {
    const original = yield* positionFor({ documentId: PdfDocumentId.make("original") });
    const cursor = encodeCursor(original);

    const error = yield* positionFor({
      documentId: PdfDocumentId.make("another"),
      cursor,
    }).pipe(Effect.flip);

    expect(error).toMatchObject({ code: "pdf_cursor_invalid" });
  }),
);
