import { Schema } from "effect";
import { PdfDocument, PdfText, ReadPdfInput, PdfErrorCode } from "./pdf.ts";

export const Target = Schema.Struct({
  tabId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  url: Schema.String.check(Schema.isMaxLength(8192)),
  title: Schema.String.check(Schema.isMaxLength(1024)),
});

export interface Target extends Schema.Schema.Type<typeof Target> {}

export const Page = Schema.Struct({
  ...Target.fields,
  text: Schema.String,
});

export interface Page extends Schema.Schema.Type<typeof Page> {}

export const Tab = Schema.Struct({ ...Target.fields, active: Schema.Boolean });

export interface Tab extends Schema.Schema.Type<typeof Tab> {}

export const ReadInput = Schema.Struct({
  tabId: Schema.optionalKey(
    Target.fields.tabId.annotate({
      description: "Tab ID from browser_list_tabs. Omit for the active tab.",
    }),
  ),
});

export interface ReadInput extends Schema.Schema.Type<typeof ReadInput> {}

export const ReadResult = Schema.Union([Page, PdfDocument]);

export type ReadResult = typeof ReadResult.Type;

// Reapply the input refinement after adding the tag; spreading fields alone loses checks.
const ReadPdfRequest = Schema.TaggedStruct("ReadPdf", ReadPdfInput.schema.fields).pipe(
  Schema.refine(
    (request): request is ReadPdfInput & { readonly _tag: "ReadPdf" } =>
      Schema.is(ReadPdfInput)(request),
    { message: "Invalid PDF target: use tabId or documentId; a cursor requires documentId." },
  ),
);

export const BrowserRequest = Schema.Union([
  Schema.TaggedStruct("Read", ReadInput.fields),
  Schema.TaggedStruct("List", {}),
  ReadPdfRequest,
]).pipe(Schema.toTaggedUnion("_tag"));

export type BrowserRequest = typeof BrowserRequest.Type;

export const Job = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  request: BrowserRequest,
});

export interface Job extends Schema.Schema.Type<typeof Job> {}

export const Reply = Schema.TaggedUnion({
  Read: { page: ReadResult },
  ReadPdf: { result: PdfText },
  List: { tabs: Schema.Array(Tab) },
  Failure: {
    message: Schema.String.check(Schema.isMaxLength(2000)),
    code: Schema.optionalKey(PdfErrorCode),
  },
});

export type Reply = typeof Reply.Type;

export const Settings = Schema.Struct({
  server: Schema.String,
  username: Schema.NonEmptyString,
  password: Schema.NonEmptyString,
  directory: Schema.NonEmptyString,
});

export interface Settings extends Schema.Schema.Type<typeof Settings> {}

export class BridgeError extends Schema.TaggedError<BridgeError>()("BridgeError", {
  message: Schema.String,
  code: Schema.optionalKey(PdfErrorCode),
}) {}

export class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const localOrigin = (server: string) => {
  const url = new URL(server);

  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Use a loopback HTTP origin, such as http://127.0.0.1:4097.");
  }

  return url.origin;
};
