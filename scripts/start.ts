import { Effect } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { discover } from "./local-service.ts";

await Effect.runPromise(
  discover(true).pipe(
    Effect.tap((settings) =>
      Effect.sync(() => {
        if (settings)
          console.log(
            `OpenCode shared service is running at ${settings.server}. Open the sidebar or run opencode.`,
          );
      }),
    ),
    Effect.provide(NodeFileSystem.layer),
  ),
);
