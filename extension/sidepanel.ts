import { Effect, Fiber, Schema, Schedule, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { BrowserError, type Settings, localOrigin } from "../shared/contracts.ts";
import { NativeReply, nativeHostName } from "../shared/native.ts";
import { browserLayer } from "./browser.ts";
import { connect } from "./connection.ts";

function element<T extends Element>(
  selector: string,
  constructor: { new (...args: never[]): T },
): T {
  const found = document.querySelector(selector);

  if (!(found instanceof constructor)) throw new Error(`Missing UI element: ${selector}`);

  return found;
}

const iframe = element("#opencode", HTMLIFrameElement);

let settings: Settings | undefined;

let sessionId: string | null = null;

const FrameLocation = Schema.Struct({
  type: Schema.Literal("opencode-chrome:location"),
  pathname: Schema.String,
});

window.addEventListener("message", (event) => {
  if (!settings || event.source !== iframe.contentWindow || event.origin !== settings.server)
    return;
  const decoded = Schema.decodeUnknownOption(FrameLocation)(event.data);

  if (Option.isNone(decoded)) return;
  const route = /^\/server\/([^/]+)\/session\/([^/]+)$/.exec(decoded.value.pathname);

  const serverKey = btoa(settings.server)
    .replace(/=+$/, "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");

  sessionId = route?.[1] === serverKey ? (route[2] ?? null) : null;
});

iframe.addEventListener("load", () => {
  if (settings)
    iframe.contentWindow?.postMessage("opencode-chrome:request-location", settings.server);
});

const resolveConnection = Effect.fn("Sidebar.discover")(function* () {
  const raw = yield* Effect.tryPromise({
    try: () => chrome.runtime.sendNativeMessage(nativeHostName, { action: "start" }),
    catch: () =>
      new BrowserError({
        message:
          "Local helper unavailable. Run bun run setup in the repository, reload the extension, then retry.",
      }),
  });

  const reply = yield* Schema.decodeUnknownEffect(NativeReply)(raw);

  const value = yield* NativeReply.match(reply, {
    Connected: ({ settings }): Effect.Effect<Settings, BrowserError> => Effect.succeed(settings),
    Unavailable: ({ message }) => Effect.fail(new BrowserError({ message })),
  });

  const origin = yield* Effect.try(() => localOrigin(value.server));

  const normalized = {
    ...value,
    server: origin,
  };

  yield* Effect.tryPromise(() => chrome.storage.session.set({ settings: normalized }));
  yield* Effect.sync(() => {
    const changed =
      !settings ||
      settings.server !== normalized.server ||
      settings.password !== normalized.password;

    settings = normalized;
    iframe.hidden = false;

    if (changed) {
      sessionId = null;
      iframe.src = normalized.server;
    }
  });

  return normalized;
});

const program = Effect.gen(function* () {
  const selected = yield* resolveConnection();
  yield* connect(selected, () => sessionId);
}).pipe(
  Effect.scoped,
  Effect.provide(browserLayer),
  Effect.provide(FetchHttpClient.layer),
  Effect.tapError((cause) => Effect.logError("Chrome sidebar connection failed", cause)),
  Effect.retry(Schedule.spaced("3 seconds")),
  Effect.catch((cause) => Effect.logError("Chrome sidebar connection stopped", cause)),
);

const running = Effect.runFork(program);

window.addEventListener("pagehide", () => {
  Effect.runFork(Fiber.interrupt(running));
});
