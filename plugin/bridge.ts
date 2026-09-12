import { Clock, Context, Deferred, Effect, Layer, Option, Ref, Semaphore } from "effect";
import {
  BridgeError,
  type Job,
  type Page,
  Reply,
  BrowserRequest,
  type ReadInput,
  type Tab,
} from "../shared/contracts.ts";

interface Pending {
  readonly job: Job;
  readonly result: Deferred.Deferred<Reply, BridgeError>;
}

interface Connection {
  readonly clientId: string;
  readonly lastSeen: number;
  readonly sessionId: string | null;
}

interface State {
  readonly connection: Option.Option<Connection>;
  readonly pending: ReadonlyMap<string, Pending>;
}

interface Interface {
  readonly isActive: (sessionId: string) => Effect.Effect<boolean>;
  readonly claim: (clientId: string, sessionId: string | null) => Effect.Effect<void, BridgeError>;
  readonly poll: (
    clientId: string,
    sessionId: string | null,
  ) => Effect.Effect<ReadonlyArray<Job>, BridgeError>;
  readonly complete: (
    clientId: string,
    id: string,
    reply: Reply,
  ) => Effect.Effect<void, BridgeError>;
  readonly release: (clientId: string) => Effect.Effect<void, BridgeError>;
  readonly list: (sessionId: string) => Effect.Effect<ReadonlyArray<Tab>, BridgeError>;
  readonly read: (sessionId: string, input?: ReadInput) => Effect.Effect<Page, BridgeError>;
}

export class Bridge extends Context.Service<Bridge, Interface>()("ChromeBridge") {}

export const bridgeLayer = Layer.effect(
  Bridge,
  Effect.gen(function* () {
    const mutex = yield* Semaphore.make(1);
    const state = yield* Ref.make<State>({ connection: Option.none(), pending: new Map() });

    const failPending = Effect.fn("Bridge.failPending")(function* (message: string) {
      const previous = yield* Ref.getAndSet(state, {
        connection: Option.none(),
        pending: new Map(),
      });

      yield* Effect.forEach(
        previous.pending.values(),
        (entry) => Deferred.fail(entry.result, new BridgeError({ message })),
        { discard: true },
      );
    });

    const current = Effect.fn("Bridge.current")(function* () {
      const now = yield* Clock.currentTimeMillis;
      const snapshot = yield* Ref.get(state);

      if (Option.isNone(snapshot.connection)) {
        return yield* Effect.fail(
          new BridgeError({
            message: "Open the Chrome sidebar to connect to this server first.",
          }),
        );
      }

      if (now - snapshot.connection.value.lastSeen > 8000) {
        yield* failPending("Chrome sidebar disconnected. Reconnect it before reading a page.");

        return yield* Effect.fail(
          new BridgeError({ message: "Chrome connection expired. Reconnect the sidebar." }),
        );
      }

      return snapshot.connection.value;
    });

    const owned = Effect.fn("Bridge.owned")(function* (clientId: string) {
      const connection = yield* current();

      if (connection.clientId !== clientId) {
        return yield* Effect.fail(
          new BridgeError({ message: "Another sidebar owns this server's browser connection." }),
        );
      }

      return connection;
    });

    yield* Effect.addFinalizer(() =>
      mutex.withPermits(1)(failPending("OpenCode unloaded the browser plugin.")),
    );

    const request = Effect.fn("Bridge.request")(function* (
      sessionId: string,
      request: BrowserRequest,
    ) {
      return yield* Effect.acquireUseRelease(
        mutex.withPermits(1)(
          Effect.gen(function* () {
            yield* current();
            const snapshot = yield* Ref.get(state);

            if (snapshot.pending.size >= 16) {
              return yield* Effect.fail(
                new BridgeError({ message: "Too many pending browser requests." }),
              );
            }

            const id = crypto.randomUUID();
            const result = yield* Deferred.make<Reply, BridgeError>();
            const job = { id, sessionId, request };
            const pending = new Map(snapshot.pending);
            pending.set(id, { job, result });
            yield* Ref.set(state, { ...snapshot, pending });

            return { id, result };
          }),
        ),
        ({ result }) =>
          Deferred.await(result).pipe(
            Effect.timeout("20 seconds"),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(new BridgeError({ message: "Chrome did not answer within 20 seconds." })),
            ),
          ),
        ({ id }) =>
          mutex.withPermits(1)(
            Ref.update(state, (value) => {
              const next = new Map(value.pending);
              next.delete(id);

              return { ...value, pending: next };
            }),
          ),
      );
    });

    return Bridge.of({
      isActive: Effect.fn("Bridge.isActive")((sessionId) =>
        current().pipe(
          Effect.map((connection) => connection.sessionId === sessionId),
          Effect.catchTag("BridgeError", () => Effect.succeed(false)),
          mutex.withPermits(1),
        ),
      ),
      claim: Effect.fn("Bridge.claim")(function* (clientId, sessionId) {
        const now = yield* Clock.currentTimeMillis;
        const snapshot = yield* Ref.get(state);

        if (
          Option.isSome(snapshot.connection) &&
          now - snapshot.connection.value.lastSeen <= 8000 &&
          snapshot.connection.value.clientId !== clientId
        ) {
          return yield* Effect.fail(
            new BridgeError({
              message: "Close the other sidebar before connecting this one.",
            }),
          );
        }

        yield* failPending("The browser connection restarted. Request the page again.");
        yield* Ref.set(state, {
          connection: Option.some({ clientId, lastSeen: now, sessionId }),
          pending: new Map(),
        });
      }, mutex.withPermits(1)),
      poll: Effect.fn("Bridge.poll")(function* (clientId, sessionId) {
        const connection = yield* owned(clientId);

        if (sessionId !== connection.sessionId) {
          yield* failPending(
            "The Chrome sidebar switched sessions. Request browser access from the visible session.",
          );
        }

        const now = yield* Clock.currentTimeMillis;
        const snapshot = yield* Ref.get(state);
        yield* Ref.set(state, {
          ...snapshot,
          connection: Option.some({
            ...connection,
            lastSeen: now,
            sessionId,
          }),
        });

        return Array.from(snapshot.pending.values(), (entry) => entry.job);
      }, mutex.withPermits(1)),
      complete: Effect.fn("Bridge.complete")(function* (clientId, id, reply) {
        yield* owned(clientId);
        const snapshot = yield* Ref.get(state);
        const pending = snapshot.pending.get(id);

        if (!pending) return;

        yield* Reply.match(reply, {
          Success: () => Deferred.succeed(pending.result, reply),
          Tabs: () => Deferred.succeed(pending.result, reply),
          Failure: ({ message }) => Deferred.fail(pending.result, new BridgeError({ message })),
        });
      }, mutex.withPermits(1)),
      release: Effect.fn("Bridge.release")(function* (clientId) {
        yield* owned(clientId);
        yield* failPending("Chrome sidebar disconnected.");
      }, mutex.withPermits(1)),
      read: Effect.fn("Bridge.read")(function* (sessionId, input = {}) {
        const reply = yield* request(sessionId, BrowserRequest.cases.Read.make(input));

        if (!Reply.guards.Success(reply))
          return yield* Effect.fail(
            new BridgeError({ message: "Chrome returned an unexpected response to a page read." }),
          );

        if (input.tabId !== undefined && reply.page.tabId !== input.tabId) {
          return yield* Effect.fail(
            new BridgeError({
              message:
                "Chrome returned a different tab than requested. Reload the extension and retry.",
            }),
          );
        }

        return reply.page;
      }),
      list: Effect.fn("Bridge.list")(function* (sessionId) {
        const reply = yield* request(sessionId, BrowserRequest.cases.List.make({}));

        if (!Reply.guards.Tabs(reply))
          return yield* Effect.fail(
            new BridgeError({
              message: "Chrome returned an unexpected response to a tab listing.",
            }),
          );

        return reply.tabs;
      }),
    });
  }),
);
