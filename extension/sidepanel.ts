import { Effect, Fiber, Schema, Schedule, Layer, Ref } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { BrowserError, type Settings, localOrigin } from "../shared/contracts.ts";
import { NativeReply, nativeHostName } from "../shared/native.ts";
import { pdfLayer } from "./pdf.ts";
import { browserLayer } from "./browser.ts";
import { connect } from "./connection.ts";
import { observeFrameSession } from "./sidebar-frame.ts";

function element<T extends Element>(
  selector: string,
  constructor: { new (...args: never[]): T },
): T {
  const found = document.querySelector(selector);

  if (!(found instanceof constructor)) throw new Error(`Missing UI element: ${selector}`);

  return found;
}

const iframe = element("#opencode", HTMLIFrameElement);

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

  return normalized;
});

const program = Effect.gen(function* () {
  const previousSettings = yield* Ref.make<Settings | undefined>(undefined);

  const connectOnce = Effect.gen(function* () {
    const settings = yield* resolveConnection();
    const selectedSession = yield* observeFrameSession(iframe, settings);
    const previous = yield* Ref.getAndSet(previousSettings, settings);

    iframe.hidden = false;

    if (previous?.server !== settings.server || previous.password !== settings.password) {
      iframe.src = settings.server;
    }

    yield* connect(settings, selectedSession);
  }).pipe(Effect.scoped);

  yield* connectOnce.pipe(
    Effect.tapError((cause) => Effect.logError("Chrome sidebar connection failed", cause)),
    Effect.retry(Schedule.spaced("3 seconds")),
    Effect.catch((cause) => Effect.logError("Chrome sidebar connection stopped", cause)),
  );
}).pipe(
  Effect.scoped,
  Effect.provide(browserLayer.pipe(Layer.provide(pdfLayer))),
  Effect.provide(FetchHttpClient.layer),
);

const running = Effect.runFork(program);

window.addEventListener("pagehide", () => {
  Effect.runFork(Fiber.interrupt(running));
});
