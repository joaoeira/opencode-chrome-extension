import { Effect, Schema } from "effect";
import {
  PdfCursor,
  PdfDocumentId,
  PdfError,
  PdfPages,
  pdfLimits,
  type ReadPdfInput,
} from "../shared/pdf.ts";

const Position = Schema.Struct({
  documentId: PdfDocumentId,
  pages: Schema.NullOr(PdfPages),
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

interface Position extends Schema.Schema.Type<typeof Position> {}

const decodeCursor = Effect.fn("PdfCursor.decode")(function* (
  cursor: PdfCursor,
  documentId: PdfDocumentId,
) {
  const position = yield* Effect.try(() => atob(cursor)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Position))),
    Effect.mapError(
      () =>
        new PdfError({
          code: "pdf_cursor_invalid",
          message: "Invalid PDF cursor. Use a cursor returned for this document.",
        }),
    ),
  );

  if (position.documentId !== documentId)
    return yield* Effect.fail(
      new PdfError({
        code: "pdf_cursor_invalid",
        message: "This cursor belongs to another PDF.",
      }),
    );

  return position;
});

export const encodeCursor = (position: Position) => PdfCursor.make(btoa(JSON.stringify(position)));

export const positionFor = Effect.fn("PdfCursor.positionFor")(function* (input: ReadPdfInput) {
  if (input.pages && input.cursor)
    return yield* Effect.fail(
      new PdfError({
        code: "pdf_pages_invalid",
        message: "Supply pages or cursor, not both.",
      }),
    );

  if (input.cursor) return yield* decodeCursor(input.cursor, input.documentId);

  return {
    documentId: input.documentId,
    pages: input.pages ? [...new Set(input.pages)].sort((a, b) => a - b) : null,
    index: 0,
    offset: 0,
  };
});

export const selectBatch = Effect.fn("PdfPagination.selectBatch")(function* (
  position: Position,
  pageCount: number,
) {
  if (position.pages?.some((page) => page > pageCount))
    return yield* Effect.fail(
      new PdfError({
        code: "pdf_pages_invalid",
        message: `This PDF has ${pageCount} physical pages. Choose pages between 1 and ${pageCount}.`,
      }),
    );
  const count = position.pages?.length ?? pageCount;

  if (position.index >= count)
    return yield* Effect.fail(
      new PdfError({
        code: "pdf_cursor_invalid",
        message: "This cursor is past the end of the selection.",
      }),
    );

  const pages = position.pages
    ? position.pages.slice(position.index, position.index + pdfLimits.batchPages)
    : Array.from(
        { length: Math.min(pdfLimits.batchPages, count - position.index) },
        (_, offset) => position.index + offset + 1,
      );

  return { pages, count };
});

export const sliceText = Effect.fn("PdfPagination.sliceText")(function* (
  text: string,
  offset: number,
) {
  if (offset > text.length)
    return yield* Effect.fail(
      new PdfError({
        code: "pdf_cursor_invalid",
        message: "This cursor is past the end of the text.",
      }),
    );
  let end = Math.min(offset + pdfLimits.responseText, text.length);
  // Never split a UTF-16 surrogate pair between tool responses.
  const last = text.charCodeAt(end - 1);

  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;

  return { text: text.slice(offset, end), end };
});
