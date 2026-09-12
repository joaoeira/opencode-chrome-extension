import { Context, Effect, Layer, Schema } from "effect";
import { BrowserError, Page, Tab, type ReadInput } from "../shared/contracts.ts";

// The separately bundled extractor is installed in Chrome's isolated script world.
declare const OpenCodePage: typeof import("./extract.ts");

interface Interface {
  readonly read: (input: ReadInput) => Effect.Effect<Page, BrowserError>;
  readonly list: () => Effect.Effect<ReadonlyArray<Tab>, BrowserError>;
}

export class Browser extends Context.Service<Browser, Interface>()("ChromeBrowser") {}

export const browserLayer = Layer.effect(
  Browser,
  Effect.gen(function* () {
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
      read: Effect.fn("Browser.read")(
        function* (input) {
          const tabs = yield* Effect.tryPromise({
            try: () =>
              chrome.tabs.query(
                input.tabId === undefined ? { active: true, windowId } : { windowId },
              ),
            catch: (cause) =>
              new BrowserError({ message: "Could not find the active tab.", cause }),
          });

          const tab =
            input.tabId === undefined ? tabs[0] : tabs.find((tab) => tab.id === input.tabId);

          const tabId = tab?.id;

          if (input.tabId !== undefined && !tab) {
            return yield* Effect.fail(
              new BrowserError({
                message: `Tab ${input.tabId} is closed or outside the sidebar's window.`,
              }),
            );
          }

          if (tabId === undefined || !tab?.url || !/^https?:\/\//.test(tab.url)) {
            return yield* Effect.fail(
              new BrowserError({ message: "The selected tab is not a readable web page." }),
            );
          }

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
                message:
                  "Cannot read this tab. It may be closed, restricted, or missing site permission.",
                cause,
              }),
          });

          const page = yield* Schema.decodeUnknownEffect(Page)({
            ...results[0]?.result,
            tabId,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new BrowserError({ message: "The page did not return readable content.", cause }),
            ),
          );

          return page;
        },
        (effect) =>
          effect.pipe(
            Effect.timeout("5 seconds"),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(new BrowserError({ message: "The page took too long to respond." })),
            ),
          ),
      ),
    });
  }),
);
