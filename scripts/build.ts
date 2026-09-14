import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { Effect } from "effect";

await Effect.runPromise(
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => mkdir("dist/extension", { recursive: true }));
    yield* Effect.tryPromise(() =>
      build({
        entryPoints: [
          "extension/background.ts",
          "extension/sidepanel.ts",
          "extension/session.ts",
          "extension/pdf-worker.ts",
        ],
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "chrome116",
        outdir: "dist/extension",
        minify: true,
        sourcemap: true,
      }),
    );
    yield* Effect.tryPromise(() =>
      build({
        entryPoints: ["extension/extract.ts"],
        bundle: true,
        format: "iife",
        globalName: "OpenCodePage",
        platform: "browser",
        target: "chrome116",
        outfile: "dist/extension/extract.js",
        minify: true,
        sourcemap: true,
      }),
    );
    yield* Effect.tryPromise(() =>
      cp(
        "node_modules/@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm",
        "dist/extension/pdf_inspector_wasm_bg.wasm",
      ),
    );
    yield* Effect.forEach(
      ["manifest.json", "sidepanel.html", "sidepanel.css"],
      (name) => Effect.tryPromise(() => cp(`extension/${name}`, `dist/extension/${name}`)),
      { concurrency: "unbounded" },
    );
    yield* Effect.logInfo("Built extension in dist/extension");
  }),
);
