import { spawn } from "node:child_process";
import { endianness } from "node:os";
import { it, expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { NativeReply } from "../shared/native.ts";

const frame = (text: string) => {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(4);

  if (endianness() === "LE") header.writeUInt32LE(payload.length);
  else header.writeUInt32BE(payload.length);

  return Buffer.concat([header, payload]);
};

const request = Effect.fn("NativeTest.request")(function* (input: Buffer) {
  const output = yield* Effect.callback<Buffer, Error>((resume) => {
    const child = spawn("bun", ["scripts/native-host.ts"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", (error) => resume(Effect.fail(error)));
    child.once("close", (code) =>
      resume(
        code === 0
          ? Effect.succeed(Buffer.concat(chunks))
          : Effect.fail(new Error(`Native host exited with ${code}`)),
      ),
    );
    child.stdin.end(input);

    return Effect.sync(() => {
      child.kill();
    });
  }).pipe(Effect.timeout("5 seconds"));

  const size = endianness() === "LE" ? output.readUInt32LE(0) : output.readUInt32BE(0);
  expect(output.length).toBe(size + 4);

  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(NativeReply))(
    output.subarray(4).toString("utf8"),
  );
});

it.live("contains malformed native requests within a valid error response", () =>
  Effect.gen(function* () {
    const oversized = Buffer.alloc(4);

    if (endianness() === "LE") oversized.writeUInt32LE(65537);
    else oversized.writeUInt32BE(65537);

    for (const input of [
      frame('{"action":"exec","command":"echo hello"}'),
      frame('{"action":"discover"}').subarray(0, 6),
      oversized,
    ]) {
      const reply = yield* request(input);
      expect(NativeReply.guards.Unavailable(reply)).toBe(true);
    }
  }),
);
