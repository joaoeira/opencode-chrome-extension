import { Service } from "@opencode/client/service";
import { expect, test, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Config, Effect, Schema } from "effect";
import { Tab } from "../shared/contracts.ts";

const ModelRequest = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
  tools: Schema.optional(
    Schema.Array(
      Schema.Struct({
        function: Schema.Struct({ name: Schema.String, parameters: Schema.Unknown }),
      }),
    ),
  ),
});

test("browser tools follow the sidebar session and deliver full content across projects", async ({
  playwright,
}) => {
  const directory = await mkdtemp(resolve(tmpdir(), "opencode-provider-test-"));
  const requests: (typeof ModelRequest.Type)[] = [];
  let fixtureUrl = "";
  let context: BrowserContext | undefined;

  const provider = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        `<!doctype html><title>Chrome fixture</title><article><p>${"Visible Chrome content. ".repeat(5500)}</p><p>ARTICLE ENDS HERE</p></article>`,
      );

      return;
    }

    const chunks: Buffer[] = [];

    for await (const chunk of request) chunks.push(Buffer.from(chunk));

    const body = Schema.decodeUnknownSync(ModelRequest)(
      JSON.parse(Buffer.concat(chunks).toString()),
    );

    requests.push(body);
    const results = body.messages.filter((message) => message.role === "tool");

    const callBrowser =
      body.tools?.some((tool) => tool.function.name === "browser_read_page") &&
      JSON.stringify(body.messages).includes("What page am I on?") &&
      results.length < 2;

    const toolName = results.length === 0 ? "browser_list_tabs" : "browser_read_page";
    const listed = results[0];

    const tabId =
      callBrowser && listed
        ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Tab)))(listed.content).find(
            (tab) => tab.url === fixtureUrl,
          )?.tabId
        : undefined;

    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: callBrowser ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${results.length}`, type: "function", function: { name: toolName, arguments: JSON.stringify(tabId === undefined ? {} : { tabId }) } }] } : { role: "assistant", content: "Hi" }, finish_reason: callBrowser ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });

  const file = resolve(directory, "state/opencode/service.json");

  const env = {
    XDG_CONFIG_HOME: resolve(directory, "config"),
    XDG_DATA_HOME: resolve(directory, "data"),
    XDG_STATE_HOME: resolve(directory, "state"),
    XDG_CACHE_HOME: resolve(directory, "cache"),
    FIXTURE_API_KEY: "local-fixture-key",
  };

  try {
    await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));

    const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(
      provider.address(),
    );

    fixtureUrl = `http://127.0.0.1:${port}/article`;
    await mkdir(resolve(directory, "config/opencode"), { recursive: true });
    await writeFile(
      resolve(directory, "config/opencode/opencode.json"),
      JSON.stringify({
        plugins: [resolve("plugin")],
        providers: {
          fixture: {
            name: "Local test provider",
            env: ["FIXTURE_API_KEY"],
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `http://127.0.0.1:${port}/v1` },
            models: {
              fixture: {
                name: "Fixture",
                capabilities: { tools: true, input: ["text"], output: ["text"] },
              },
            },
          },
        },
      }),
    );

    const endpoint = await Service.ensure({
      file,
      version: "2.0.2",
      command: [
        resolve("node_modules/.bin/opencode"),
        "serve",
        "--service",
        "--hostname",
        "127.0.0.1",
        "--port",
        "0",
      ],
      env,
    });

    const post = async (path: string, body: Schema.Json) => {
      const response = await fetch(`${endpoint.url}/api/${path}`, {
        method: "POST",
        headers: { ...Service.headers(endpoint), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);

      return result;
    };

    const createSession = async () =>
      Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }))(
        await post("session", {
          location: { directory },
          model: { providerID: "fixture", id: "fixture" },
        }),
      ).data.id;

    const first = await createSession();
    const second = await createSession();
    let sequence = 0;

    const visibleTools = async (sessionId: string) => {
      const text = `Tool visibility probe ${sequence++}`;
      await post(`session/${sessionId}/prompt`, { text });
      await expect
        .poll(() =>
          requests.some(
            (request) =>
              request.tools !== undefined && JSON.stringify(request.messages).includes(text),
          ),
        )
        .toBe(true);

      return requests
        .find(
          (request) =>
            request.tools !== undefined && JSON.stringify(request.messages).includes(text),
        )
        ?.tools?.flatMap((tool) =>
          tool.function.name.startsWith("browser_") ? [tool.function.name] : [],
        )
        .sort();
    };

    const browserTools = ["browser_list_tabs", "browser_read_page"];
    expect(await visibleTools(first)).toEqual([]);

    const profile = resolve(directory, "chrome-profile");
    execFileSync("bun", ["scripts/install-native.ts"], {
      env: {
        ...process.env,
        ...env,
        OPENCODE_CHROME_PORT: "0",
        OPENCODE_CHROME_HOST_DIRECTORY: resolve(profile, "NativeMessagingHosts"),
      },
    });

    const executablePath = await Effect.runPromise(
      Config.string("CHROMIUM_EXECUTABLE").pipe(
        Config.withDefault(playwright.chromium.executablePath()),
      ),
    );

    const extension = resolve("dist/extension");
    context = await playwright.chromium.launchPersistentContext(profile, {
      executablePath,
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const target = await context.newPage();
    await target.goto(fixtureUrl);
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    await expect(panel.locator("#opencode")).toBeVisible();

    const frame = await panel
      .locator("#opencode")
      .elementHandle()
      .then((element) => element?.contentFrame());

    if (!frame) throw new Error("Expected OpenCode iframe");

    const route = (id: string) =>
      `/server/${Buffer.from(endpoint.url).toString("base64url")}/session/${id}`;

    await frame.goto(`${endpoint.url}${route(first)}`);
    await target.bringToFront();
    await expect.poll(() => visibleTools(first), { timeout: 15000 }).toEqual(browserTools);
    expect(await visibleTools(second)).toEqual([]);

    await post(`session/${first}/prompt`, { text: "What page am I on?" });
    await expect
      .poll(
        () =>
          requests
            .flatMap((request) => request.messages)
            .flatMap((message) => (message.role === "tool" ? [message.content] : [])),
        { timeout: 15000 },
      )
      .toContainEqual(expect.stringContaining("ARTICLE ENDS HERE"));
    expect(
      requests
        .flatMap((request) => request.tools ?? [])
        .find((tool) => tool.function.name === "browser_read_page")?.function.parameters,
    ).toMatchObject({ type: "object", properties: { tabId: { type: "integer" } } });
    expect(JSON.stringify(requests)).not.toContain("browser.tabs.list");

    // SPA navigation must transfer access without reloading the sidebar or its connection.
    await frame.evaluate((path) => {
      history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, route(second));
    await expect.poll(() => visibleTools(second), { timeout: 15000 }).toEqual(browserTools);
    expect(await visibleTools(first)).toEqual([]);
    await frame.evaluate(() => {
      history.pushState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect.poll(() => visibleTools(second)).toEqual([]);
    await frame.goto(`${endpoint.url}${route(second)}`);
    await expect.poll(() => visibleTools(second)).toEqual(browserTools);
    await panel.close();
    await expect.poll(() => visibleTools(second), { timeout: 15000 }).toEqual([]);
  } finally {
    await Service.stop({ file });
    await context?.close();
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
