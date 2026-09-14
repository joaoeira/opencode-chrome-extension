import { Schema } from "effect";

export const pdfLimits = {
  batchPages: 3,
  responseText: 24_000,
  documents: 2,
  documentTtlMs: 10 * 60_000,
  selectedPages: 20,
  downloadBytes: 250 * 1024 * 1024,
  batchText: 16 * 1024 * 1024,
  cachedBatches: 4,
} as const;

// Each outer deadline leaves time to report the inner timeout to its caller.
export const pdfWorkerTimeoutMs = 60_000;

export const pdfOperationTimeoutMs = pdfWorkerTimeoutMs + 5_000;

export const pdfBridgeTimeoutMs = pdfOperationTimeoutMs + 5_000;

export const PdfDocumentId = Schema.NonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("PdfDocumentId"),
);

export type PdfDocumentId = typeof PdfDocumentId.Type;

export const PdfCursor = Schema.NonEmptyString.check(Schema.isMaxLength(4096)).pipe(
  Schema.brand("PdfCursor"),
);

export type PdfCursor = typeof PdfCursor.Type;

export const PdfPageNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const PdfPages = Schema.Array(PdfPageNumber).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(pdfLimits.selectedPages),
);

const PdfSelection = Schema.Struct({
  pages: Schema.optionalKey(PdfPages),
  cursor: Schema.optionalKey(PdfCursor),
});

export const ReadPdfDocumentInput = Schema.Struct({
  ...PdfSelection.fields,
  documentId: PdfDocumentId,
});

export interface ReadPdfDocumentInput extends Schema.Schema.Type<typeof ReadPdfDocumentInput> {}

type PdfTarget =
  | { readonly tabId: number; readonly documentId?: never; readonly cursor?: never }
  | { readonly documentId: PdfDocumentId; readonly tabId?: never };

export const ReadPdfInput = Schema.Struct({
  ...PdfSelection.fields,
  documentId: Schema.optionalKey(PdfDocumentId),
  tabId: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}).pipe(
  Schema.refine(
    (input): input is typeof input & PdfTarget =>
      input.tabId === undefined
        ? input.documentId !== undefined
        : input.documentId === undefined && input.cursor === undefined,
    {
      message:
        "Supply exactly one of tabId or documentId. A cursor requires documentId, without tabId.",
    },
  ),
);

export type ReadPdfInput = typeof ReadPdfInput.Type;

export const PdfDocument = Schema.Struct({
  type: Schema.Literal("pdf"),
  documentId: PdfDocumentId,
  tabId: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  pageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export interface PdfDocument extends Schema.Schema.Type<typeof PdfDocument> {}

export const PdfWarning = Schema.Struct({
  pages: Schema.Array(PdfPageNumber),
  message: Schema.String,
});

export const PdfText = Schema.Struct({
  documentId: PdfDocumentId,
  tabId: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  pageCount: PdfDocument.fields.pageCount,
  pages: PdfPages,
  text: Schema.String,
  nextCursor: Schema.NullOr(PdfCursor),
  warnings: Schema.optionalKey(Schema.Array(PdfWarning)),
});

export interface PdfText extends Schema.Schema.Type<typeof PdfText> {}

export const PdfErrorCode = Schema.Literals([
  "pdf_tab_not_pdf",
  "pdf_unavailable",
  "pdf_document_expired",
  "pdf_document_changed",
  "pdf_cursor_invalid",
  "pdf_pages_invalid",
  "pdf_password_required",
  "pdf_extraction_failed",
  "pdf_too_large",
]);

export class PdfError extends Schema.TaggedError<PdfError>()("PdfError", {
  code: PdfErrorCode,
  message: Schema.String,
}) {}

export const PdfWorkerRequest = Schema.TaggedUnion({
  Open: { url: Schema.String },
  Extract: { pages: PdfPages },
});

export type PdfWorkerRequest = typeof PdfWorkerRequest.Type;

export const PdfWorkerReply = Schema.TaggedUnion({
  Opened: { pageCount: PdfDocument.fields.pageCount },
  Extracted: { text: Schema.String, warnings: Schema.Array(PdfWarning) },
  Failed: { code: PdfErrorCode, message: Schema.String },
});

export type PdfWorkerReply = typeof PdfWorkerReply.Type;
