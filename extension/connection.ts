import { OpenCode } from "@opencode/client/effect";
import { Effect, Schedule } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { type Settings, BrowserRequest, Reply, localOrigin } from "../shared/contracts.ts";
import { BrowserRpc } from "../shared/rpc.ts";
import { Browser } from "./browser.ts";

const clientFor = Effect.fn("Sidebar.client")(function* (settings: Settings) {
  const origin = yield* Effect.try(() => localOrigin(settings.server));
  const base = yield* HttpClient.HttpClient;

  const http = base.pipe(
    HttpClient.mapRequest(
      HttpClientRequest.setHeader(
        "authorization",
        `Basic ${btoa(`${settings.username}:${settings.password}`)}`,
      ),
    ),
  );

  return yield* OpenCode.make({ baseUrl: origin }).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
  );
});

export const connect = Effect.fn("Sidebar.connect")(function* (
  settings: Settings,
  currentSession: () => string | null,
) {
  const browser = yield* Browser;
  const client = yield* clientFor(settings);
  const rpc = client.rpc(BrowserRpc);
  const clientId = crypto.randomUUID();
  const options = { location: { directory: settings.directory } };

  yield* rpc.claim({ clientId, sessionId: currentSession() }, options);
  yield* Effect.addFinalizer(() =>
    rpc.release({ clientId }, options).pipe(
      Effect.timeout("2 seconds"),
      Effect.catch(() => Effect.void),
    ),
  );

  const poll = Effect.gen(function* () {
    const jobs = yield* rpc.poll({ clientId, sessionId: currentSession() }, options);
    yield* Effect.forEach(
      jobs,
      (job) =>
        Effect.gen(function* () {
          const reply = yield* BrowserRequest.match(job.request, {
            Read: (input) =>
              browser
                .read(input)
                .pipe(Effect.map((page): Reply => Reply.cases.Success.make({ page }))),
            List: () =>
              browser.list().pipe(Effect.map((tabs): Reply => Reply.cases.Tabs.make({ tabs }))),
          }).pipe(
            Effect.catchTag("BrowserError", (error) =>
              Effect.succeed(Reply.cases.Failure.make({ message: error.message })),
            ),
          );

          yield* rpc.complete({ clientId, id: job.id, reply }, options);
        }),
      { concurrency: 4, discard: true },
    );
  });

  // Polls retain pending requests server-side; a transient fetch failure loses no event.
  yield* poll.pipe(
    Effect.retry(Schedule.exponential("200 millis").pipe(Schedule.upTo({ times: 2 }))),
    Effect.repeat(Schedule.spaced("1 second")),
  );
});
