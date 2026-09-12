import { Service } from "@opencode/client/service";
import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Schema } from "effect";
import { Reply, Job, BrowserRequest } from "../shared/contracts.ts";

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

test("exposes the Chrome reader and delivers its result to the model without desktop browser tools", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "opencode-provider-test-"));
  const requests: (typeof ModelRequest.Type)[] = [];

  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];

    for await (const chunk of request) chunks.push(Buffer.from(chunk));

    const body = Schema.decodeUnknownSync(ModelRequest)(
      JSON.parse(Buffer.concat(chunks).toString()),
    );

    requests.push(body);

    const resultCount = body.messages.filter((message) => message.role === "tool").length;

    const callReader =
      body.tools?.some((tool) => tool.function.name === "browser_read_page") && resultCount < 2;

    const toolName = resultCount === 0 ? "browser_list_tabs" : "browser_read_page";

    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: callReader ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${resultCount}`, type: "function", function: { name: toolName, arguments: resultCount === 0 ? "{}" : JSON.stringify({ tabId: 123 }) } }] } : { role: "assistant", content: "Hi" }, finish_reason: callReader ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });

  const file = resolve(directory, "state/opencode/service.json");

  try {
    await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));

    const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(
      provider.address(),
    );

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
      env: {
        XDG_CONFIG_HOME: resolve(directory, "config"),
        XDG_DATA_HOME: resolve(directory, "data"),
        XDG_STATE_HOME: resolve(directory, "state"),
        XDG_CACHE_HOME: resolve(directory, "cache"),
        FIXTURE_API_KEY: "local-fixture-key",
      },
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

    const session = Schema.decodeUnknownSync(
      Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
    )(
      await post("session", {
        location: { directory },
        model: { providerID: "fixture", id: "fixture" },
      }),
    );

    const sidebarDirectory = resolve(directory, "sidebar-project");
    await mkdir(sidebarDirectory);

    const rpc = (method: string, input: Schema.Json) =>
      post(
        `rpc/chrome/${method}?${new URLSearchParams({ "location[directory]": sidebarDirectory })}`,
        {
          input,
        },
      );

    await rpc("claim", { clientId: "fixture-sidebar" });
    await post(`session/${session.data.id}/prompt`, { text: "What page am I on?" });
    await expect
      .poll(
        () =>
          requests
            .flatMap((request) => request.tools ?? [])
            .find((tool) => tool.function.name === "browser_read_page")?.function.parameters,
        { timeout: 30000 },
      )
      .toMatchObject({ type: "object", properties: {} });

    expect(JSON.stringify(requests)).not.toContain("browser.tabs.list");

    const jobs = Schema.Struct({ output: Schema.Array(Job) });
    let job: Job | undefined;
    await expect
      .poll(async () => {
        job = Schema.decodeUnknownSync(jobs)(await rpc("poll", { clientId: "fixture-sidebar" }))
          .output[0];

        return job;
      })
      .toBeDefined();
    expect(job?.request._tag).toBe("List");
    await rpc("complete", {
      clientId: "fixture-sidebar",
      id: job?.id ?? "",
      reply: Reply.cases.Tabs.make({
        tabs: [
          { tabId: 123, title: "Chrome fixture", url: "https://example.com/chrome", active: false },
        ],
      }),
    });
    await expect
      .poll(async () => {
        job = Schema.decodeUnknownSync(jobs)(
          await rpc("poll", { clientId: "fixture-sidebar" }),
        ).output.find((job) => BrowserRequest.guards.Read(job.request));

        return job?.request;
      })
      .toMatchObject({ tabId: 123 });
    await rpc("complete", {
      clientId: "fixture-sidebar",
      id: job?.id ?? "",
      reply: Reply.cases.Success.make({
        page: {
          tabId: 123,
          title: "Chrome fixture",
          url: "https://example.com/chrome",
          text: "Visible Chrome content. ".repeat(5000) + "END_OF_ARTICLE",
        },
      }),
    });
    await expect
      .poll(() =>
        requests
          .flatMap((request) => request.messages)
          .flatMap((message) => (message.role === "tool" ? [message.content] : [])),
      )
      .toContainEqual(expect.stringContaining("END_OF_ARTICLE"));
  } finally {
    await Service.stop({ file });
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
