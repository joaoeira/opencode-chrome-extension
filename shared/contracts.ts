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

export const ReadInput = Schema.Struct({ tabId: Schema.optional(Target.fields.tabId) });

export interface ReadInput extends Schema.Schema.Type<typeof ReadInput> {}

export const ReadResult = Schema.Union([Page, PdfDocument]);

export type ReadResult = typeof ReadResult.Type;

export const BrowserRequest = Schema.TaggedUnion({
  Read: ReadInput.fields,
  List: {},
  ReadPdf: ReadPdfInput.fields,
});

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
