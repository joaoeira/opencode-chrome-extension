import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import { Config, Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { Settings, localOrigin } from "../shared/contracts.ts";

export class LocalServiceError extends Schema.TaggedError<LocalServiceError>()(
  "LocalServiceError",
  { message: Schema.String },
) {}

const bundled = resolve("node_modules/.bin/opencode");

// Each OpenCode release owns its service discovery protocol, so the helper delegates to the
// user's installed CLI instead of a pinned client library. `bun run` puts the bundled CLI on
// PATH, so it is skipped there and used only when no other installation exists.
const executable = Effect.fn("LocalService.executable")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;

  for (const directory of path.split(delimiter)) {
    if (directory === "") continue;
    const candidate = resolve(directory, "opencode");

    if (candidate === bundled) continue;
    const info = yield* fs.stat(candidate).pipe(Effect.option);

    const runnable = Option.exists(
      info,
      (file) => file.type !== "Directory" && (file.mode & 0o111) !== 0,
    );

    if (runnable) return candidate;
  }

  return bundled;
});

export const configuration = Effect.gen(function* () {
  const directory = process.cwd();
  const path = yield* Config.string("PATH").pipe(Config.withDefault(""));
  const override = yield* Config.string("OPENCODE_CHROME_OPENCODE").pipe(Config.withDefault(""));

  const data = yield* Config.string("XDG_DATA_HOME").pipe(
    Config.withDefault(resolve(homedir(), ".local/share")),
  );

  const state = yield* Config.string("XDG_STATE_HOME").pipe(
    Config.withDefault(resolve(homedir(), ".local/state")),
  );

  const cache = yield* Config.string("XDG_CACHE_HOME").pipe(
    Config.withDefault(resolve(homedir(), ".cache")),
  );

  const config = yield* Config.string("XDG_CONFIG_HOME").pipe(
    Config.withDefault(resolve(homedir(), ".config")),
  );

  const env = {
    PATH: path,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
  };

  return {
    directory,
    env,
    override,
    file: resolve(env.XDG_STATE_HOME, "opencode/service.json"),
    executable: override === "" ? yield* executable(path) : resolve(override),
  };
});

// The registration file is OpenCode's stable discovery contract for credentials.
const Registration = Schema.Struct({
  url: Schema.String,
  password: Schema.optional(Schema.String),
});

const service = Effect.fn("LocalService.service")(
  function* (action: "start" | "status") {
    const config = yield* configuration;

    const handle = yield* ChildProcess.make(config.executable, ["service", action], {
      cwd: config.directory,
      env: config.env,
      extendEnv: true,
    });

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );

    if (exitCode !== 0) {
      return yield* new LocalServiceError({
        message: stderr.trim() || `${config.executable} service ${action} exited with ${exitCode}.`,
      });
    }

    return stdout;
  },
  Effect.scoped,
  Effect.mapError((cause) =>
    cause instanceof LocalServiceError
      ? cause
      : new LocalServiceError({ message: `Could not run OpenCode: ${cause.message}` }),
  ),
);

export const discover = Effect.fn("LocalService.discover")(function* (start: boolean) {
  const config = yield* configuration;
  const output = yield* service(start ? "start" : "status");

  const printed = output
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.startsWith("http://") || line.startsWith("https://"));

  if (printed === undefined) {
    if (!start) return undefined;

    return yield* new LocalServiceError({
      message: `OpenCode did not report a service URL: ${output.trim()}`,
    });
  }

  const origin = (url: string) =>
    Effect.try({
      try: () => localOrigin(url),
      catch: (cause) => new LocalServiceError({ message: String(cause) }),
    });

  const server = yield* origin(printed);

  const fs = yield* FileSystem.FileSystem;

  const registration = yield* fs
    .readFileString(config.file)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Registration))));

  if ((yield* origin(registration.url)) !== server) {
    return yield* new LocalServiceError({
      message: "OpenCode's service registration does not match the running service.",
    });
  }

  return yield* Schema.decodeUnknownEffect(Settings)({
    server,
    username: "opencode",
    password: registration.password,
    directory: config.directory,
  });
});
