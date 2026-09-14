import { endianness } from "node:os";
import { Effect, Logger, Option, Result, Schema, Stdio, Stream } from "effect";
import { NodeFileSystem, NodeStdio } from "@effect/platform-node";
import { NativeRequest, NativeReply } from "../shared/native.ts";
import { discover } from "./local-service.ts";

// Chrome sends one length-prefixed JSON frame per native-host process.
// filterMapEffect skips Result failures while more bytes arrive; malformed frames fail the Effect.
const completeFrame = Effect.fn("NativeHost.completeFrame")(function* (buffer: Buffer) {
  if (buffer.length < 4) return Result.fail(undefined);
  const size = endianness() === "LE" ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);

  if (size > 65536) return yield* Effect.fail(new Error("Native request exceeds 64 KiB."));

  if (buffer.length < size + 4) return Result.fail(undefined);

  return Result.succeed(buffer.subarray(4, size + 4));
});

const receive = Effect.gen(function* () {
  const io = yield* Stdio.Stdio;

  const frame = yield* io.stdin.pipe(
    Stream.scan(Buffer.alloc(0), (buffer, chunk) => Buffer.concat([buffer, chunk])),
    Stream.filterMapEffect(completeFrame),
    Stream.runHead,
  );

  if (Option.isNone(frame)) return yield* Effect.fail(new Error("Incomplete native request."));

  return frame.value;
});

await Effect.runPromise(
  Effect.gen(function* () {
    const payload = yield* receive.pipe(Effect.timeout("5 seconds"));

    const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(NativeRequest))(
      payload.toString("utf8"),
    );

    const settings = yield* discover(request.action === "start");

    return settings
      ? NativeReply.cases.Connected.make({ settings })
      : NativeReply.cases.Unavailable.make({ message: "OpenCode is not running. Start it below." });
  }).pipe(
    Effect.timeout("45 seconds"),
    Effect.catch((cause) =>
      Effect.succeed(NativeReply.cases.Unavailable.make({ message: String(cause) })),
    ),
    Effect.flatMap((reply) =>
      Effect.gen(function* () {
        const io = yield* Stdio.Stdio;
        const body = Buffer.from(JSON.stringify(reply));
        const header = Buffer.alloc(4);

        if (endianness() === "LE") header.writeUInt32LE(body.length);
        else header.writeUInt32BE(body.length);
        yield* Stream.make(header, body).pipe(Stream.run(io.stdout({ endOnDone: true })));
      }),
    ),
    Effect.provide(NodeStdio.layer),
    Effect.provide(NodeFileSystem.layer),
    Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatSimple)])),
  ),
);
