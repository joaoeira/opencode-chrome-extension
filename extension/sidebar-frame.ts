import { Effect, Encoding, Schema, Stream, SubscriptionRef } from "effect";
import type { Settings } from "../shared/contracts.ts";

const FrameLocation = Schema.Struct({
  type: Schema.Literal("opencode-chrome:location"),
  pathname: Schema.String,
});

export const observeFrameSession = Effect.fn("Sidebar.observeFrameSession")(function* (
  iframe: HTMLIFrameElement,
  settings: Settings,
) {
  const selected = yield* SubscriptionRef.make<string | null>(null);
  const serverKey = Encoding.encodeBase64Url(settings.server);

  const requestLocation = Effect.sync(() => {
    iframe.contentWindow?.postMessage("opencode-chrome:request-location", settings.server);
  });

  yield* Stream.fromEventListener<MessageEvent>(window, "message").pipe(
    Stream.filter(
      (event) => event.source === iframe.contentWindow && event.origin === settings.server,
    ),
    Stream.filterMap((event) => Schema.decodeUnknownResult(FrameLocation)(event.data)),
    Stream.map((location) => {
      const route = /^\/server\/([^/]+)\/session\/([^/]+)$/.exec(location.pathname);

      return route?.[1] === serverKey ? (route[2] ?? null) : null;
    }),
    Stream.runForEach((sessionId) => SubscriptionRef.set(selected, sessionId)),
    Effect.forkScoped({ startImmediately: true }),
  );

  yield* Stream.fromEventListener(iframe, "load").pipe(
    Stream.runForEach(() => requestLocation),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* requestLocation;

  return selected;
});
