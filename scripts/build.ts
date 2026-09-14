import { NodeFileSystem } from "@effect/platform-node";
import { build } from "esbuild";
import { Effect, FileSystem } from "effect";

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory("dist/extension", { recursive: true });
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
    yield* fs.copyFile(
      "node_modules/@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm",
      "dist/extension/pdf_inspector_wasm_bg.wasm",
    );
    yield* Effect.forEach(
      ["manifest.json", "sidepanel.html", "sidepanel.css"],
      (name) => fs.copyFile(`extension/${name}`, `dist/extension/${name}`),
      { concurrency: "unbounded" },
    );
    yield* Effect.logInfo("Built extension in dist/extension");
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);
