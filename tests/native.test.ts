import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
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

const request = Effect.fn("NativeTest.request")(function* (
  input: Buffer,
  env: NodeJS.ProcessEnv = process.env,
) {
  const output = yield* Effect.callback<Buffer, Error>((resume) => {
    const child = spawn(process.execPath, ["scripts/native-host.ts"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
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

it.live("connects to whatever service the installed OpenCode CLI reports", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "opencode-chrome-native-"))),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );

    const bin = join(root, "bin");
    const state = join(root, "state");

    yield* Effect.promise(async () => {
      await mkdir(bin);
      await mkdir(join(state, "opencode"), { recursive: true });

      // Stands in for an OpenCode release newer than the bundled client understands.
      await writeFile(
        join(bin, "opencode"),
        '#!/bin/sh\n[ "$1 $2" = "service start" ] && echo http://127.0.0.1:4555\n',
      );

      await chmod(join(bin, "opencode"), 0o755);

      await writeFile(
        join(state, "opencode/service.json"),
        JSON.stringify({
          version: "9.9.9",
          url: "http://127.0.0.1:4555",
          pid: 1,
          password: "secret",
        }),
      );
    });

    const reply = yield* request(frame('{"action":"start"}'), {
      HOME: root,
      PATH: `${bin}:/usr/bin:/bin`,
      XDG_STATE_HOME: state,
    });

    if (!NativeReply.guards.Connected(reply))
      throw new Error(`Expected a connection: ${reply.message}`);

    expect(reply.settings.server).toBe("http://127.0.0.1:4555");
    expect(reply.settings.password).toBe("secret");
  }).pipe(Effect.scoped),
);
