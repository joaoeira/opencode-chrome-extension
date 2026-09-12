import { Effect, Schema } from "effect";
import { Settings, localOrigin } from "../shared/contracts.ts";

const attempts = new Set<string>();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    const program = Effect.gen(function* () {
      const stored = yield* Effect.tryPromise(() => chrome.storage.session.get("settings"));
      const settings = yield* Schema.decodeUnknownEffect(Settings)(stored.settings);
      const origin = yield* Effect.try(() => localOrigin(settings.server));

      if (details.isProxy || new URL(details.url).origin !== origin) return {};

      const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;

      if (details.initiator !== extensionOrigin && details.initiator !== origin) return {};

      if (attempts.has(details.requestId)) return { cancel: true };

      attempts.add(details.requestId);

      return { authCredentials: { username: settings.username, password: settings.password } };
    }).pipe(Effect.catch(() => Effect.succeed({})));

    void Effect.runPromise(program).then(callback);
  },
  { urls: ["http://127.0.0.1/*", "http://localhost/*"] },
  ["asyncBlocking"],
);

const clearAttempt = (
  details: chrome.webRequest.OnCompletedDetails | chrome.webRequest.OnErrorOccurredDetails,
) => {
  attempts.delete(details.requestId);
};

chrome.webRequest.onCompleted.addListener(clearAttempt, {
  urls: ["http://127.0.0.1/*", "http://localhost/*"],
});

chrome.webRequest.onErrorOccurred.addListener(clearAttempt, {
  urls: ["http://127.0.0.1/*", "http://localhost/*"],
});
