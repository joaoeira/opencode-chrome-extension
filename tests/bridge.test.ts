import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { Bridge, bridgeLayer } from "../plugin/bridge.ts";
import { Reply } from "../shared/contracts.ts";

const target = { tabId: 7, title: "Example", url: "https://example.com/" };

const page = { ...target, text: "Hello from Chrome" };

it.effect("routes a read to the sidebar and returns its result", () =>
  Effect.gen(function* () {
    const bridge = yield* Bridge;
    yield* bridge.claim("sidebar", null);

    const read = yield* bridge
      .read("session-1")
      .pipe(Effect.forkScoped({ startImmediately: true }));

    const jobs = yield* bridge.poll("sidebar", null);
    expect(jobs).toHaveLength(1);
    const job = jobs[0];

    if (!job) throw new Error("Expected queued job");
    expect(job.sessionId).toBe("session-1");
    yield* bridge.complete("sidebar", job.id, Reply.cases.Success.make({ page }));
    expect((yield* Fiber.join(read)).text).toBe("Hello from Chrome");
    expect(yield* bridge.poll("sidebar", null)).toEqual([]);
  }).pipe(Effect.provide(bridgeLayer)),
);

it.effect("rejects another sidebar without changing connection ownership", () =>
  Effect.gen(function* () {
    const bridge = yield* Bridge;
    yield* bridge.claim("first", null);
    expect((yield* Effect.flip(bridge.claim("second", null))).message).toContain("other sidebar");
    expect((yield* Effect.flip(bridge.poll("second", null))).message).toContain("Another sidebar");
    expect(yield* bridge.poll("first", null)).toEqual([]);
  }).pipe(Effect.provide(bridgeLayer)),
);

it.effect("rejects replies from the wrong connection", () =>
  Effect.gen(function* () {
    const bridge = yield* Bridge;
    yield* bridge.claim("first", null);
    const read = yield* bridge.read("session").pipe(Effect.forkScoped({ startImmediately: true }));
    const [job] = yield* bridge.poll("first", null);

    if (!job) throw new Error("Expected queued job");
    expect(
      (yield* Effect.flip(bridge.complete("second", job.id, Reply.cases.Success.make({ page }))))
        .message,
    ).toContain("Another sidebar");
    yield* bridge.complete("first", job.id, Reply.cases.Success.make({ page }));
    expect((yield* Fiber.join(read)).text).toBe("Hello from Chrome");
  }).pipe(Effect.provide(bridgeLayer)),
);

it.effect("fails a pending read when the sidebar disconnects", () =>
  Effect.gen(function* () {
    const bridge = yield* Bridge;
    yield* bridge.claim("sidebar", null);

    const read = yield* bridge
      .read("session")
      .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));

    yield* bridge.release("sidebar");
    expect((yield* Fiber.join(read)).message).toContain("disconnected");
  }).pipe(Effect.provide(bridgeLayer)),
);

it.effect("expires a connection after missed heartbeats", () =>
  Effect.gen(function* () {
    const bridge = yield* Bridge;
    yield* bridge.claim("sidebar", null);
    yield* TestClock.adjust("9 seconds");
    expect((yield* Effect.flip(bridge.read("session"))).message).toContain("expired");
    yield* bridge.claim("new-sidebar", null);
    expect(yield* bridge.poll("new-sidebar", null)).toEqual([]);
  }).pipe(Effect.provide(bridgeLayer)),
);

it.effect("times out and removes an unanswered read", () =>
  Effect.gen(function* () {
    const bridge = yield* Bridge;
    yield* bridge.claim("sidebar", null);

    const read = yield* bridge
      .read("session")
      .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));

    for (const delay of [6000, 6000, 6000]) {
      yield* TestClock.adjust(delay);
      yield* bridge.poll("sidebar", null);
    }

    yield* TestClock.adjust("2 seconds");
    expect((yield* Fiber.join(read)).message).toContain("20 seconds");
    expect(yield* bridge.poll("sidebar", null)).toHaveLength(0);
  }).pipe(Effect.provide(bridgeLayer)),
);

it.effect("removes interrupted reads from the sidebar queue", () =>
  Effect.gen(function* () {
    const bridge = yield* Bridge;
    yield* bridge.claim("sidebar", null);

    const reads = yield* Effect.forEach(["a", "b", "c"], (id) =>
      bridge.read(id).pipe(Effect.forkScoped({ startImmediately: true })),
    );

    const jobs = yield* bridge.poll("sidebar", null);
    expect(jobs.map((job) => job.sessionId).sort()).toEqual(["a", "b", "c"]);
    yield* Effect.forEach(reads, Fiber.interrupt);
    expect(yield* bridge.poll("sidebar", null)).toEqual([]);
  }).pipe(Effect.provide(bridgeLayer)),
);

it.effect("delivers out-of-order replies to their original callers", () =>
  Effect.gen(function* () {
    const bridge = yield* Bridge;
    yield* bridge.claim("sidebar", null);
    const first = yield* bridge.read("first").pipe(Effect.forkScoped({ startImmediately: true }));
    const second = yield* bridge.read("second").pipe(Effect.forkScoped({ startImmediately: true }));
    const jobs = yield* bridge.poll("sidebar", null);
    const firstJob = jobs.find((job) => job.sessionId === "first");
    const secondJob = jobs.find((job) => job.sessionId === "second");

    if (!firstJob || !secondJob) throw new Error("Expected both queued reads");
    yield* bridge.complete(
      "sidebar",
      secondJob.id,
      Reply.cases.Success.make({ page: { ...page, text: "second result" } }),
    );
    yield* bridge.complete(
      "sidebar",
      firstJob.id,
      Reply.cases.Success.make({ page: { ...page, text: "first result" } }),
    );
    expect((yield* Fiber.join(first)).text).toBe("first result");
    expect((yield* Fiber.join(second)).text).toBe("second result");
  }).pipe(Effect.provide(bridgeLayer)),
);

it.effect("rejects a page from the wrong tab instead of returning it to the caller", () =>
  Effect.gen(function* () {
    const bridge = yield* Bridge;
    yield* bridge.claim("sidebar", null);

    const read = yield* bridge
      .read("session", { tabId: 99 })
      .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));

    const [job] = yield* bridge.poll("sidebar", null);

    if (!job) throw new Error("Expected queued read");
    yield* bridge.complete("sidebar", job.id, Reply.cases.Success.make({ page }));
    expect((yield* Fiber.join(read)).message).toContain("different tab");
    expect(yield* bridge.poll("sidebar", null)).toHaveLength(0);
  }).pipe(Effect.provide(bridgeLayer)),
);

it.effect("cancels queued browser work when the sidebar switches sessions", () =>
  Effect.gen(function* () {
    const bridge = yield* Bridge;
    yield* bridge.claim("sidebar", "first");

    const read = yield* bridge
      .read("first")
      .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));

    expect(yield* bridge.poll("sidebar", "second")).toHaveLength(0);
    expect((yield* Fiber.join(read)).message).toContain("switched sessions");
  }).pipe(Effect.provide(bridgeLayer)),
);
