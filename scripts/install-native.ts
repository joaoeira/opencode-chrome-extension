import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { Config, Effect, Schema } from "effect";
import { configuration } from "./local-service.ts";
import { nativeHostName } from "../shared/native.ts";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

await Effect.runPromise(
  Effect.gen(function* () {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return yield* Effect.fail(new Error("Native host setup currently supports macOS and Linux."));
    }

    const manifest = yield* Effect.tryPromise(() => readFile("extension/manifest.json", "utf8"));

    const { key } = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ key: Schema.String })),
    )(manifest);

    const id = createHash("sha256")
      .update(Buffer.from(key, "base64"))
      .digest("hex")
      .slice(0, 32)
      .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));

    const override = yield* Config.string("OPENCODE_CHROME_HOST_DIRECTORY").pipe(
      Config.withDefault(""),
    );

    const port = yield* Config.int("OPENCODE_CHROME_PORT").pipe(Config.withDefault(0));

    const config = yield* configuration;

    const environment = Object.entries(config.env)
      .map(([key, value]) => `export ${key}=${quote(value)}`)
      .join("\n");

    const directories = override
      ? [resolve(override)]
      : process.platform === "darwin"
        ? ["Google/Chrome", "Google/ChromeForTesting", "Chromium"].map((browser) =>
            join(homedir(), "Library/Application Support", browser, "NativeMessagingHosts"),
          )
        : ["google-chrome", "google-chrome-for-testing", "chromium"].map((browser) =>
            join(homedir(), ".config", browser, "NativeMessagingHosts"),
          );

    for (const directory of directories) {
      yield* Effect.tryPromise(() => mkdir(directory, { recursive: true, mode: 0o700 }));
      const launcher = join(directory, `${nativeHostName}.sh`);
      const script = `#!/bin/sh\ncd ${quote(process.cwd())} || exit 1\nexport OPENCODE_CHROME_PORT=${quote(String(port))}\n${environment}\nexec ${quote(process.execPath)} ${quote(resolve("scripts/native-host.ts"))} "$@"\n`;
      yield* Effect.tryPromise(() => writeFile(launcher, script, { mode: 0o700 }));
      yield* Effect.tryPromise(() => chmod(launcher, 0o700));
      yield* Effect.tryPromise(() =>
        writeFile(
          join(directory, `${nativeHostName}.json`),
          JSON.stringify(
            {
              name: nativeHostName,
              description: "Discover and start the local OpenCode sidebar server",
              path: launcher,
              type: "stdio",
              allowed_origins: [`chrome-extension://${id}/`],
            },
            null,
            2,
          ),
          { mode: 0o600 },
        ),
      );
    }

    console.log(`Registered native helper for extension ${id}. Reload dist/extension in Chrome.`);
  }),
);
