import { OpenCode } from "@opencode/client/effect";
import { Effect, FiberMap, Schedule, Semaphore, Stream, SubscriptionRef } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { type Settings, BrowserRequest, Reply, localOrigin } from "../shared/contracts.ts";
import { PdfError } from "../shared/pdf.ts";
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
  selectedSession: SubscriptionRef.SubscriptionRef<string | null>,
) {
  const browser = yield* Browser;
  const client = yield* clientFor(settings);
  const rpc = client.rpc(BrowserRpc);
  const clientId = crypto.randomUUID();
  const options = { location: { directory: settings.directory } };

  const initialSession = yield* SubscriptionRef.get(selectedSession);
  yield* rpc.claim({ clientId, sessionId: initialSession }, options);
  yield* Effect.addFinalizer(() =>
    rpc.release({ clientId }, options).pipe(
      Effect.timeout("2 seconds"),
      Effect.catch(() => Effect.void),
    ),
  );

  const execution = yield* Semaphore.make(4);

  const execute = Effect.fn("Sidebar.execute")((sessionId: string, request: BrowserRequest) =>
    BrowserRequest.match(request, {
      Read: (input) =>
        browser
          .read(sessionId, input)
          .pipe(Effect.map((page): Reply => Reply.cases.Read.make({ page }))),
      ReadPdf: (input) =>
        browser
          .readPdf(sessionId, input)
          .pipe(Effect.map((result): Reply => Reply.cases.ReadPdf.make({ result }))),
      List: () => browser.list().pipe(Effect.map((tabs): Reply => Reply.cases.List.make({ tabs }))),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Reply.cases.Failure.make(
            error instanceof PdfError
              ? { code: error.code, message: error.message }
              : { message: error.message },
          ),
        ),
      ),
      Effect.catchDefect(() =>
        Effect.succeed(
          Reply.cases.Failure.make({
            message: "Browser extraction failed unexpectedly. Retry the read.",
          }),
        ),
      ),
      execution.withPermits(1),
    ),
  );

  const runSession = Effect.fn("Sidebar.runSession")(function* (sessionId: string | null) {
    // The job scope closes before the document cache is cleared.
    yield* Effect.addFinalizer(() => browser.forgetSessionDocuments);
    const active = yield* FiberMap.make<string, void>();

    const poll = Effect.gen(function* () {
      const jobs = yield* rpc.poll({ clientId, sessionId }, options);

      for (const [id] of active) {
        if (!jobs.some((job) => job.id === id)) yield* FiberMap.remove(active, id);
      }

      for (const job of jobs) {
        yield* FiberMap.run(
          active,
          job.id,
          Effect.gen(function* () {
            const reply = yield* execute(job.sessionId, job.request);

            // Retain the result in this fiber while delivery retries. Re-polling must
            // not extract again. Completion is idempotent; poll cancels the fiber
            // when the server removes the job, including after a lost acknowledgement.
            yield* rpc
              .complete({ clientId, id: job.id, reply }, options)
              .pipe(Effect.retry(Schedule.spaced("500 millis")));
          }).pipe(Effect.catch((cause) => Effect.logError("Chrome job completion failed", cause))),
          { onlyIfMissing: true },
        );
      }
    });

    // Polls retain pending requests server-side; a transient fetch failure loses no event.
    yield* poll.pipe(
      Effect.retry(Schedule.exponential("200 millis").pipe(Schedule.upTo({ times: 2 }))),
      Effect.repeat(Schedule.spaced("1 second")),
    );
  }, Effect.scoped);

  yield* SubscriptionRef.changes(selectedSession).pipe(
    Stream.changes,
    Stream.switchMap((sessionId) => Stream.fromEffect(runSession(sessionId))),
    Stream.runDrain,
  );
});
