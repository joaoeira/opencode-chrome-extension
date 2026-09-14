import { Clock, Context, Deferred, Effect, Layer, Option, SynchronizedRef } from "effect";
import {
  BridgeError,
  type Job,
  type ReadResult,
  Reply,
  BrowserRequest,
  type ReadInput,
  type Tab,
} from "../shared/contracts.ts";
import { pdfBridgeTimeoutMs, type PdfText, type ReadPdfInput } from "../shared/pdf.ts";

// Read may discover a PDF only after Chrome inspects the tab. Allow the PDF deadline.
const deadlineFor = (request: BrowserRequest) =>
  BrowserRequest.guards.List(request) ? 20_000 : pdfBridgeTimeoutMs;

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
  readonly readPdf: (sessionId: string, input: ReadPdfInput) => Effect.Effect<PdfText, BridgeError>;
  readonly list: (sessionId: string) => Effect.Effect<ReadonlyArray<Tab>, BridgeError>;
  readonly read: (sessionId: string, input?: ReadInput) => Effect.Effect<ReadResult, BridgeError>;
}

export class Bridge extends Context.Service<Bridge, Interface>()("ChromeBridge") {}

export const bridgeLayer = Layer.effect(
  Bridge,
  Effect.gen(function* () {
    const emptyState = (): State => ({ connection: Option.none(), pending: new Map() });
    const state = yield* SynchronizedRef.make(emptyState());

    const failPending = (snapshot: State, message: string) =>
      Effect.forEach(
        snapshot.pending.values(),
        (entry) => Deferred.fail(entry.result, new BridgeError({ message })),
        { discard: true },
      );

    const expireConnection = SynchronizedRef.modifyEffect(state, (snapshot) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        const expired =
          Option.isSome(snapshot.connection) && now - snapshot.connection.value.lastSeen > 8000;

        if (!expired) return [false, snapshot] as const;
        yield* failPending(snapshot, "Chrome connection expired. Reconnect the sidebar.");

        return [true, emptyState()] as const;
      }),
    );

    // Commit expiry separately: a rejected operation must not restore expired state.
    // Each transition then validates the current connection under the ref's lock.
    const update = <A>(
      transition: (snapshot: State) => Effect.Effect<readonly [A, State], BridgeError>,
    ) =>
      Effect.gen(function* () {
        if (yield* expireConnection) {
          return yield* Effect.fail(
            new BridgeError({ message: "Chrome connection expired. Reconnect the sidebar." }),
          );
        }

        return yield* SynchronizedRef.modifyEffect(state, transition);
      });

    const current = (snapshot: State) =>
      Option.match(snapshot.connection, {
        onNone: () =>
          Effect.fail(
            new BridgeError({
              message: "Open the Chrome sidebar to connect to this server first.",
            }),
          ),
        onSome: Effect.succeed,
      });

    const owned = Effect.fn("Bridge.owned")(function* (snapshot: State, clientId: string) {
      const connection = yield* current(snapshot);

      if (connection.clientId !== clientId) {
        return yield* Effect.fail(
          new BridgeError({
            message: "Another sidebar owns this server's browser connection.",
          }),
        );
      }

      return connection;
    });

    yield* Effect.addFinalizer(() =>
      SynchronizedRef.updateEffect(state, (snapshot) =>
        failPending(snapshot, "OpenCode unloaded the browser plugin.").pipe(
          Effect.as(emptyState()),
        ),
      ),
    );

    const request = Effect.fn("Bridge.request")(function* (
      sessionId: string,
      request: BrowserRequest,
    ) {
      return yield* Effect.acquireUseRelease(
        update((snapshot: State) =>
          Effect.gen(function* () {
            yield* current(snapshot);

            if (snapshot.pending.size >= 16) {
              return yield* Effect.fail(
                new BridgeError({ message: "Too many pending browser requests." }),
              );
            }

            const id = crypto.randomUUID();
            const result = yield* Deferred.make<Reply, BridgeError>();
            const pending = new Map(snapshot.pending);
            pending.set(id, { job: { id, sessionId, request }, result });

            return [
              { id, result },
              { ...snapshot, pending },
            ] as const;
          }),
        ),
        ({ result }) =>
          Deferred.await(result).pipe(
            Effect.timeoutOrElse({
              duration: deadlineFor(request),
              orElse: () =>
                Effect.fail(
                  new BridgeError({
                    message: "Chrome did not answer before the request deadline.",
                  }),
                ),
            }),
          ),
        ({ id }) =>
          SynchronizedRef.update(state, (snapshot) => {
            const pending = new Map(snapshot.pending);
            pending.delete(id);

            return { ...snapshot, pending };
          }),
      );
    });

    return Bridge.of({
      isActive: Effect.fn("Bridge.isActive")((sessionId) =>
        update((snapshot: State) =>
          Effect.gen(function* () {
            const connection = yield* current(snapshot);

            return [connection.sessionId === sessionId, snapshot] as const;
          }),
        ).pipe(Effect.catchTag("BridgeError", () => Effect.succeed(false))),
      ),
      claim: Effect.fn("Bridge.claim")((clientId, sessionId) =>
        Effect.andThen(
          expireConnection,
          SynchronizedRef.modifyEffect(state, (snapshot: State) =>
            Effect.gen(function* () {
              if (
                Option.isSome(snapshot.connection) &&
                snapshot.connection.value.clientId !== clientId
              ) {
                return yield* Effect.fail(
                  new BridgeError({
                    message: "Close the other sidebar before connecting this one.",
                  }),
                );
              }

              yield* failPending(
                snapshot,
                "The browser connection restarted. Request the page again.",
              );
              const now = yield* Clock.currentTimeMillis;

              return [
                undefined,
                {
                  connection: Option.some({ clientId, sessionId, lastSeen: now }),
                  pending: new Map(),
                },
              ] as const;
            }),
          ),
        ),
      ),
      poll: Effect.fn("Bridge.poll")((clientId, sessionId) =>
        update((snapshot: State) =>
          Effect.gen(function* () {
            const connection = yield* owned(snapshot, clientId);
            let pending = snapshot.pending;

            if (sessionId !== connection.sessionId) {
              yield* failPending(
                snapshot,
                "The Chrome sidebar switched sessions. Request browser access from the visible session.",
              );
              pending = new Map();
            }

            const now = yield* Clock.currentTimeMillis;

            const next = {
              connection: Option.some({ ...connection, sessionId, lastSeen: now }),
              pending,
            };

            return [Array.from(pending.values(), (entry) => entry.job), next] as const;
          }),
        ),
      ),
      complete: Effect.fn("Bridge.complete")((clientId, id, reply) =>
        update((snapshot: State) =>
          Effect.gen(function* () {
            yield* owned(snapshot, clientId);
            const pending = snapshot.pending.get(id);

            if (pending) {
              if (Reply.guards.Failure(reply)) {
                yield* Deferred.fail(
                  pending.result,
                  new BridgeError(
                    reply.code
                      ? { message: reply.message, code: reply.code }
                      : { message: reply.message },
                  ),
                );
              } else {
                yield* Deferred.succeed(pending.result, reply);
              }
            }

            return [undefined, snapshot] as const;
          }),
        ),
      ),
      release: Effect.fn("Bridge.release")((clientId) =>
        update((snapshot: State) =>
          Effect.gen(function* () {
            yield* owned(snapshot, clientId);
            yield* failPending(snapshot, "Chrome sidebar disconnected.");

            return [undefined, emptyState()] as const;
          }),
        ),
      ),
      read: Effect.fn("Bridge.read")(function* (sessionId, input = {}) {
        const reply = yield* request(sessionId, BrowserRequest.cases.Read.make(input));

        if (!Reply.guards.Read(reply))
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
      readPdf: Effect.fn("Bridge.readPdf")(function* (sessionId, input) {
        const reply = yield* request(sessionId, BrowserRequest.cases.ReadPdf.make(input));

        if (
          !Reply.guards.ReadPdf(reply) ||
          (input.documentId !== undefined && reply.result.documentId !== input.documentId) ||
          (input.tabId !== undefined && reply.result.tabId !== input.tabId)
        )
          return yield* Effect.fail(
            new BridgeError({ message: "Chrome returned an unexpected PDF document." }),
          );

        return reply.result;
      }),
      list: Effect.fn("Bridge.list")(function* (sessionId) {
        const reply = yield* request(sessionId, BrowserRequest.cases.List.make({}));

        if (!Reply.guards.List(reply))
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
