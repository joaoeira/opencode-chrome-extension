import { execFileSync } from "node:child_process";
import { Service } from "@opencode/client/service";
import {
  expect,
  test as base,
  type BrowserContext,
  type Page as BrowserPage,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Config, Effect, Schema } from "effect";
import { Page, Tab, type ReadInput } from "../shared/contracts.ts";

const serviceFile = resolve(".local/test-runtime/state/opencode/service.json");

const serviceOptions = (port: number) => ({
  file: serviceFile,
  version: "2.0.2",
  command: [
    resolve("node_modules/.bin/opencode"),
    "serve",
    "--service",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  env: {
    XDG_DATA_HOME: resolve(".local/test-runtime/data"),
    XDG_STATE_HOME: resolve(".local/test-runtime/state"),
    XDG_CACHE_HOME: resolve(".local/test-runtime/cache"),
  },
});

interface BrowserFixture {
  panel: BrowserPage;
  target: BrowserPage;
  context: BrowserContext;
  fixtureUrl: string;
  read: (input?: ReadInput) => Promise<Response>;
  list: () => Promise<Response>;
}

const test = base.extend<{ browserFixture: BrowserFixture }>({
  browserFixture: async ({ playwright }, use) => {
    await Service.ensure(serviceOptions(4099));

    const fixture = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        request.url === "/long"
          ? `<!doctype html><title>Long page</title><article><p>${"A full article paragraph about browser extraction. ".repeat(1600)}</p><p>ARTICLE ENDS HERE</p></article>`
          : '<!doctype html><title>Browser tool fixture</title><nav>NAVIGATION_NOISE <a href="/menu">Menu</a></nav><article><h1>Chrome bridge works</h1><p>A useful article with <strong>important details</strong> and a <a href="/source">source link</a>.</p><p hidden>SECRET_HIDDEN_TEXT</p></article>',
      );
    });

    await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", done));

    const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(
      fixture.address(),
    );

    const fixtureUrl = `http://127.0.0.1:${port}/`;
    const extension = resolve("dist/extension");
    const profile = await mkdtemp(resolve(tmpdir(), "opencode-chrome-test-"));
    execFileSync("bun", ["scripts/install-native.ts"], {
      env: {
        ...process.env,
        OPENCODE_CHROME_HOST_DIRECTORY: resolve(profile, "NativeMessagingHosts"),
        ...serviceOptions(4099).env,
        OPENCODE_CHROME_PORT: "4099",
      },
    });

    const executablePath = await Effect.runPromise(
      Config.string("CHROMIUM_EXECUTABLE").pipe(
        Config.withDefault(playwright.chromium.executablePath()),
      ),
    );

    const context = await playwright.chromium.launchPersistentContext(profile, {
      executablePath,
      headless: true,
      viewport: { width: 420, height: 850 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });

    try {
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
      const id = new URL(worker.url()).host;
      const target = await context.newPage();
      await target.goto(fixtureUrl);
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${id}/sidepanel.html`);
      await expect(panel.locator("#opencode")).toBeVisible({ timeout: 15000 });
      await target.bringToFront();

      const rpc = async (method: "read" | "list", input: ReadInput = {}) => {
        const endpoint = await Service.discover({ file: serviceFile });

        if (!endpoint) throw new Error("Expected test server to be running");

        return fetch(
          `${endpoint.url}/api/rpc/chrome/${method}?${new URLSearchParams({ "location[directory]": process.cwd() })}`,
          {
            method: "POST",
            signal: AbortSignal.timeout(25000),
            headers: { ...Service.headers(endpoint), "Content-Type": "application/json" },
            body: JSON.stringify({ input }),
          },
        );
      };

      await expect.poll(async () => (await rpc("read")).status, { timeout: 15000 }).toBe(200);

      await use({
        panel,
        target,
        context,
        fixtureUrl,
        read: (input) => rpc("read", input),
        list: () => rpc("list"),
      });
    } finally {
      await Service.stop({ file: serviceFile });
      await context.close();
      fixture.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
});

const readPage = async (fixture: BrowserFixture, input: ReadInput = {}) => {
  const response = await fixture.read(input);
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);

  return Schema.decodeUnknownSync(Schema.Struct({ output: Page }))(body).output;
};

test("opens the upstream web UI without importing credentials", async ({
  browserFixture: fixture,
}) => {
  const iframe = fixture.panel.frameLocator("#opencode");
  await expect(iframe.getByRole("button").first()).toBeVisible({ timeout: 20000 });
  await fixture.target.bringToFront();
  const page = await readPage(fixture);
  expect(page.text).toContain("Chrome bridge works");
  expect(page.text).not.toContain("SECRET_HIDDEN_TEXT");
  expect(page.text).not.toContain("NAVIGATION_NOISE");
  expect(page.text).toContain("**important details**");
  expect(page.text).toContain(`[source link](${fixture.fixtureUrl}source)`);
  await expect(fixture.target.locator("nav")).toContainText("NAVIGATION_NOISE");
  await fixture.panel.screenshot({ path: ".local/sidebar-tested.png" });
});

test("each read follows the active tab in the sidebar window and reports its identity", async ({
  browserFixture: fixture,
}) => {
  const original = await readPage(fixture);
  expect(original.title).toBe("Browser tool fixture");
  expect(original.url).toBe(fixture.fixtureUrl);
  const second = await fixture.context.newPage();
  await second.goto(`${fixture.fixtureUrl}second`);
  await second.bringToFront();
  const switched = await readPage(fixture);
  expect(switched.url).toBe(`${fixture.fixtureUrl}second`);
  expect(switched.tabId).not.toBe(original.tabId);
  await fixture.target.bringToFront();
  expect((await readPage(fixture)).tabId).toBe(original.tabId);
  const worker = fixture.context.serviceWorkers()[0];

  if (!worker) throw new Error("Expected extension worker");

  const otherWindowId = await worker.evaluate(
    async (url) => (await chrome.windows.create({ url, focused: true }))?.id,
    `${fixture.fixtureUrl}other-window`,
  );

  expect((await readPage(fixture)).tabId).toBe(original.tabId);

  if (otherWindowId === undefined) throw new Error("Expected another window");
  await worker.evaluate((id) => chrome.windows.remove(id), otherWindowId);
  await fixture.target.goto(`${fixture.fixtureUrl}changed`);
  expect((await readPage(fixture)).url).toBe(`${fixture.fixtureUrl}changed`);
});

test("returns the complete extracted article beyond the old text limit", async ({
  browserFixture: fixture,
}) => {
  await fixture.target.goto(`${fixture.fixtureUrl}long`);
  const page = await readPage(fixture);
  expect(page.text.length).toBeGreaterThan(80000);
  expect(page.text).toContain("ARTICLE ENDS HERE");
  expect(page).not.toHaveProperty("truncated");
});

test("contains unreadable-tab failures and can read the next web page", async ({
  browserFixture: fixture,
}) => {
  await fixture.target.goto("about:blank");
  const response = await fixture.read();
  expect(response.status).toBe(400);
  expect(JSON.stringify(await response.json())).toContain("not a readable web page");
  await fixture.target.goto(fixture.fixtureUrl);
  expect((await readPage(fixture)).url).toBe(fixture.fixtureUrl);
});

test("rediscovers a restarted server at a new address without user action", async ({
  browserFixture: fixture,
}) => {
  await Service.stop({ file: serviceFile });
  await Service.ensure(serviceOptions(4100));
  await expect.poll(async () => (await fixture.read()).status, { timeout: 20000 }).toBe(200);
  expect((await readPage(fixture)).url).toBe(fixture.fixtureUrl);
  // The upstream controls prove the iframe authenticated as well as the RPC client.
  await expect(fixture.panel.frameLocator("#opencode").getByRole("button").first()).toBeVisible({
    timeout: 20000,
  });
});

test("automatically starts a stopped server when the sidebar opens", async ({
  browserFixture: fixture,
}) => {
  await Service.stop({ file: serviceFile });
  await fixture.panel.reload();
  await fixture.target.bringToFront();
  await expect
    .poll(async () => Boolean(await Service.discover({ file: serviceFile })), { timeout: 30000 })
    .toBe(true);
  await expect.poll(async () => (await fixture.read()).status, { timeout: 15000 }).toBe(200);
  expect((await readPage(fixture)).url).toBe(fixture.fixtureUrl);
});

const listTabs = async (fixture: BrowserFixture) => {
  const response = await fixture.list();
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);

  return Schema.decodeUnknownSync(Schema.Struct({ output: Schema.Array(Tab) }))(body).output;
};

test("lists tab identities and reads a background tab without activating it", async ({
  browserFixture: fixture,
}) => {
  const background = await fixture.context.newPage();
  await background.goto(`${fixture.fixtureUrl}background`);
  await fixture.target.bringToFront();
  const tabs = await listTabs(fixture);
  const selected = tabs.find((tab) => tab.url === `${fixture.fixtureUrl}background`);

  if (!selected) throw new Error("Expected background tab in listing");
  expect(selected).toMatchObject({ title: "Browser tool fixture", active: false });
  expect(tabs.find((tab) => tab.url === fixture.fixtureUrl)?.active).toBe(true);
  const page = await readPage(fixture, { tabId: selected.tabId });
  expect(page.url).toBe(selected.url);
  expect(page.text).toContain("**important details**");
  expect((await listTabs(fixture)).find((tab) => tab.active)?.url).toBe(fixture.fixtureUrl);
});

test("rejects closed and other-window tab IDs without falling back to the active tab", async ({
  browserFixture: fixture,
}) => {
  const closed = await fixture.context.newPage();
  await closed.goto(`${fixture.fixtureUrl}closed`);
  const tabs = await listTabs(fixture);
  const selected = tabs.find((tab) => tab.url === `${fixture.fixtureUrl}closed`);

  if (!selected) throw new Error("Expected temporary tab");
  await closed.close();
  await fixture.target.bringToFront();
  const worker = fixture.context.serviceWorkers()[0];

  if (!worker) throw new Error("Expected extension worker");

  const foreign = await worker.evaluate(async (url) => {
    const window = await chrome.windows.create({ url, focused: true });

    return window?.tabs?.[0]?.id;
  }, `${fixture.fixtureUrl}foreign`);

  if (foreign === undefined) throw new Error("Expected tab in another window");
  expect((await listTabs(fixture)).some((tab) => tab.tabId === foreign)).toBe(false);

  for (const tabId of [selected.tabId, foreign]) {
    const response = await fixture.read({ tabId });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("closed or outside");
  }

  expect((await readPage(fixture)).url).toBe(fixture.fixtureUrl);
});
