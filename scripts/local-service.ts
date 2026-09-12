import { homedir } from "node:os";
import { resolve } from "node:path";
import { Config, Effect, Schema } from "effect";
import { Service } from "@opencode/client/effect/service";
import { Settings, localOrigin } from "../shared/contracts.ts";

export const configuration = Effect.gen(function* () {
  const port = yield* Config.int("OPENCODE_CHROME_PORT").pipe(Config.withDefault(0));
  const directory = process.cwd();

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
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
  };

  return {
    directory,
    env,
    file: resolve(env.XDG_STATE_HOME, "opencode/service.json"),
    version: "2.0.2",
    command: [
      resolve("node_modules/.bin/opencode"),
      "serve",
      "--service",
      "--hostname",
      "127.0.0.1",
      ...(port > 0 ? ["--port", String(port)] : []),
    ],
  };
});

export const discover = Effect.fn("LocalService.discover")(function* (start: boolean) {
  const config = yield* configuration;
  const endpoint = yield* start ? Service.ensure(config) : Service.discover(config);

  if (!endpoint) return undefined;
  const server = yield* Effect.try(() => localOrigin(endpoint.url));

  return yield* Schema.decodeUnknownEffect(Settings)({
    server,
    username: endpoint.auth?.username,
    password: endpoint.auth?.password,
    directory: config.directory,
  });
});
