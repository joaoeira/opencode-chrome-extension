import { Context, Effect, Layer, Schema } from "effect";
import { BrowserError, Page, Tab, type ReadInput, type ReadResult } from "../shared/contracts.ts";
import { PdfDocuments, withPdfDeadline } from "./pdf.ts";
import { PdfError, type PdfText, type ReadPdfInput } from "../shared/pdf.ts";

// The separately bundled extractor is installed in Chrome's isolated script world.
declare const OpenCodePage: typeof import("./extract.ts");

interface Interface {
  readonly read: (
    sessionId: string,
    input: ReadInput,
  ) => Effect.Effect<ReadResult, BrowserError | PdfError>;
  readonly readPdf: (
    sessionId: string,
    input: ReadPdfInput,
  ) => Effect.Effect<PdfText, BrowserError | PdfError>;
  readonly forgetSessionDocuments: Effect.Effect<void>;
  readonly list: () => Effect.Effect<ReadonlyArray<Tab>, BrowserError>;
}

export class Browser extends Context.Service<Browser, Interface>()("ChromeBrowser") {}

const withBrowserDeadline = <A, R>(effect: Effect.Effect<A, BrowserError, R>) =>
  effect.pipe(
    Effect.timeout("5 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new BrowserError({ message: "The page took too long to respond." })),
    ),
  );

const readHtml = Effect.fn("Browser.readHtml")(function* (tabId: number) {
  const injected = yield* Effect.tryPromise({
    try: () => chrome.scripting.executeScript({ target: { tabId }, files: ["extract.js"] }),
    catch: (cause) =>
      new BrowserError({ message: "Cannot load the page extractor in this tab.", cause }),
  });

  const documentId = injected[0]?.documentId;

  if (!documentId)
    return yield* Effect.fail(
      new BrowserError({ message: "The active page disappeared before extraction." }),
    );

  const results = yield* Effect.tryPromise({
    try: () =>
      chrome.scripting.executeScript({
        target: { tabId, documentIds: [documentId] },
        func: () => OpenCodePage.read(),
      }),
    catch: (cause) =>
      new BrowserError({
        message: "Cannot read this tab. It may be closed, restricted, or missing site permission.",
        cause,
      }),
  });

  const page = yield* Schema.decodeUnknownEffect(Page)({
    ...results[0]?.result,
    tabId,
  }).pipe(
    Effect.mapError(
      (cause) => new BrowserError({ message: "The page did not return readable content.", cause }),
    ),
  );

  return page;
}, withBrowserDeadline);

const inspectTab = Effect.fn("Browser.inspectTab")(function* (windowId: number, input: ReadInput) {
  const tabs = yield* Effect.tryPromise({
    try: () =>
      chrome.tabs.query(input.tabId === undefined ? { active: true, windowId } : { windowId }),
    catch: (cause) => new BrowserError({ message: "Could not find the active tab.", cause }),
  });

  const tab = input.tabId === undefined ? tabs[0] : tabs.find((tab) => tab.id === input.tabId);

  const tabId = tab?.id;

  if (input.tabId !== undefined && !tab) {
    return yield* Effect.fail(
      new BrowserError({
        message: `Tab ${input.tabId} is closed or outside the sidebar's window.`,
      }),
    );
  }

  if (
    tabId === undefined ||
    !tab?.url ||
    !/^(https?:\/\/|blob:https?:\/\/|file:\/\/)/.test(tab.url)
  ) {
    return yield* Effect.fail(
      new BrowserError({ message: "The selected tab is not a readable web page." }),
    );
  }

  if (tab.url.startsWith("file:")) {
    const allowed = yield* Effect.tryPromise({
      try: () => chrome.extension.isAllowedFileSchemeAccess(),
      catch: (cause) =>
        new BrowserError({ message: "Could not check Chrome's file access permission.", cause }),
    });

    if (!allowed)
      return yield* Effect.fail(
        new BrowserError({
          message:
            'Enable "Allow access to file URLs" for OpenCode Sidebar in chrome://extensions, then read this tab again.',
        }),
      );
  }

  const [probe] = yield* Effect.tryPromise({
    try: () =>
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.contentType,
      }),
    catch: (cause) =>
      new BrowserError({
        message: "Cannot inspect this tab. It may be restricted or missing site permission.",
        cause,
      }),
  });

  if (!probe?.documentId)
    return yield* Effect.fail(
      new BrowserError({ message: "The page disappeared during inspection." }),
    );

  return {
    contentType: probe.result,
    source: {
      title: tab.title ?? "",
      url: tab.url,
      tabId,
      windowId,
      chromeDocumentId: probe.documentId,
    },
  };
}, withBrowserDeadline);

export const browserLayer = Layer.effect(
  Browser,
  Effect.gen(function* () {
    const pdf = yield* PdfDocuments;

    const window = yield* Effect.tryPromise({
      try: () => chrome.windows.getCurrent(),
      catch: (cause) =>
        new BrowserError({ message: "Could not identify the sidebar's window.", cause }),
    });

    const windowId = window.id;

    if (windowId === undefined) {
      return yield* Effect.fail(
        new BrowserError({ message: "The sidebar has no browser window." }),
      );
    }

    return Browser.of({
      readPdf: Effect.fn("Browser.readPdf")(
        function* (sessionId, input) {
          if (input.tabId !== undefined) {
            const tab = yield* inspectTab(windowId, { tabId: input.tabId });

            if (tab.contentType !== "application/pdf")
              return yield* Effect.fail(
                new PdfError({
                  code: "pdf_tab_not_pdf",
                  message: "This tab is not a PDF. Use browser_read_page to read its content.",
                }),
              );

            return yield* pdf.readTab(sessionId, tab.source, input.pages);
          }

          return yield* pdf.read(sessionId, input);
        },
        // Include inspection in the 65-second budget to leave margin below the
        // 70-second bridge deadline; inspection plus a separate PDF budget would not.
        withPdfDeadline,
      ),
      forgetSessionDocuments: pdf.forgetSessionDocuments,
      list: Effect.fn("Browser.list")(function* () {
        const tabs = yield* Effect.tryPromise({
          try: () => chrome.tabs.query({ windowId }),
          catch: (cause) =>
            new BrowserError({ message: "Could not list tabs in the sidebar's window.", cause }),
        });

        return yield* Schema.decodeUnknownEffect(Schema.Array(Tab))(
          tabs
            .sort((a, b) => a.index - b.index)
            .flatMap((tab) =>
              tab.id === undefined
                ? []
                : [
                    {
                      tabId: tab.id,
                      title: (tab.title ?? "").slice(0, 1024),
                      url: tab.url ?? "",
                      active: tab.active,
                    },
                  ],
            ),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new BrowserError({ message: "Chrome returned an invalid tab listing.", cause }),
          ),
        );
      }),
      read: Effect.fn("Browser.read")(function* (sessionId, input) {
        const tab = yield* inspectTab(windowId, input);

        if (tab.contentType === "application/pdf") {
          return yield* pdf.open(sessionId, tab.source);
        }

        return yield* readHtml(tab.source.tabId);
      }),
    });
  }),
);
