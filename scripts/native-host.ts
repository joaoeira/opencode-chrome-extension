import { endianness } from "node:os";
import { Effect, Logger, Schema } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { NativeRequest, NativeReply } from "../shared/native.ts";
import { discover } from "./local-service.ts";

// sendNativeMessage uses one process per request. Only framed JSON goes to stdout.
const receive = Effect.callback<Buffer, Error>((resume) => {
  let buffer = Buffer.alloc(0);

  const data = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    if (buffer.length < 4) return;
    const size = endianness() === "LE" ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);

    if (size > 65536) {
      resume(Effect.fail(new Error("Native request exceeds 64 KiB.")));

      return;
    }

    if (buffer.length >= size + 4) resume(Effect.succeed(buffer.subarray(4, size + 4)));
  };

  const end = () => resume(Effect.fail(new Error("Incomplete native request.")));
  process.stdin.on("data", data);
  process.stdin.once("end", end);
  process.stdin.once("error", end);

  return Effect.sync(() => {
    process.stdin.off("data", data);
    process.stdin.off("end", end);
    process.stdin.off("error", end);
    process.stdin.pause();
  });
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
      Effect.tryPromise(() => {
        const body = Buffer.from(JSON.stringify(reply));
        const header = Buffer.alloc(4);

        if (endianness() === "LE") header.writeUInt32LE(body.length);
        else header.writeUInt32BE(body.length);

        return new Promise<void>((resolve, reject) => {
          process.stdout.write(Buffer.concat([header, body]), (error) =>
            error ? reject(error) : resolve(),
          );
        });
      }),
    ),
    Effect.provide(NodeFileSystem.layer),
    Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatSimple)])),
  ),
);
