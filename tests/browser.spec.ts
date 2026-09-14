import { execFileSync } from "node:child_process";
import { Service } from "@opencode/client/service";
import {
  expect,
  test as base,
  type BrowserContext,
  type Page as BrowserPage,
} from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { Config, Deferred, Effect, Schema } from "effect";
import { pagedPdf, denseLines, pdfFixture } from "./pdf-fixture.ts";
import { PdfDocument, PdfText, type ReadPdfInput } from "../shared/pdf.ts";
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
  readPdf: (input: ReadPdfInput) => Promise<Response>;
}

const test = base.extend<{ browserFixture: BrowserFixture }>({
  browserFixture: async ({ playwright }, use) => {
    await Service.ensure(serviceOptions(4099));

    const encrypted = await readFile(resolve("tests/fixtures/encrypted.pdf"));

    const fixture = createServer((request, response) => {
      if (request.url === "/encrypted-pdf") {
        response.writeHead(200, { "Content-Type": "application/pdf" });
        response.end(encrypted);

        return;
      }

      if (request.url === "/pdf" || request.url === "/blank-pdf") {
        if (!request.headers.cookie?.includes("pdf_session=yes")) {
          response.writeHead(401);
          response.end("Login required");

          return;
        }

        response.writeHead(200, { "Content-Type": "application/pdf", "Cache-Control": "no-store" });
        response.end(request.url === "/pdf" ? pagedPdf : pdfFixture([[]]));

        return;
      }

      response.setHeader("Set-Cookie", "pdf_session=yes; HttpOnly; SameSite=Strict; Path=/");
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

      const rpc = async (
        method: "read" | "list" | "readPdf",
        input: ReadInput | ReadPdfInput = {},
      ) => {
        const endpoint = await Service.discover({ file: serviceFile });

        if (!endpoint) throw new Error("Expected test server to be running");

        return fetch(
          `${endpoint.url}/api/rpc/chrome/${method}?${new URLSearchParams({ "location[directory]": process.cwd() })}`,
          {
            method: "POST",
            signal: AbortSignal.timeout(75000),
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
        readPdf: (input) => rpc("readPdf", input),
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

const openPdf = async (fixture: BrowserFixture) => {
  const response = await fixture.read();
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.output).not.toHaveProperty("text");
  expect(body.output).not.toHaveProperty("_tag");

  return Schema.decodeUnknownSync(Schema.Struct({ output: PdfDocument }))(body).output;
};

const readPdf = async (fixture: BrowserFixture, input: ReadPdfInput) => {
  const response = await fixture.readPdf(input);
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.output).not.toHaveProperty("_tag");

  return Schema.decodeUnknownSync(Schema.Struct({ output: PdfText }))(body).output;
};

test("opens an authenticated PDF as metadata and preserves all text through repeatable cursors", async ({
  browserFixture: fixture,
}) => {
  await fixture.target.goto(`${fixture.fixtureUrl}pdf`);
  const document = await openPdf(fixture);
  expect(document).toMatchObject({ type: "pdf", pageCount: 4, url: `${fixture.fixtureUrl}pdf` });
  let result = await readPdf(fixture, { documentId: document.documentId, pages: [1] });
  expect(result.text.length).toBeLessThanOrEqual(24000);
  const chunks = [result.text];
  expect(result.nextCursor).not.toBeNull();

  if (!result.nextCursor) throw new Error("Expected dense page continuation");
  const cursor = result.nextCursor;
  const first = await readPdf(fixture, { documentId: document.documentId, cursor });
  const retry = await readPdf(fixture, { documentId: document.documentId, cursor });
  expect(retry.text).toBe(first.text);
  expect(retry.nextCursor).toBe(first.nextCursor);
  let requests = 0;

  while (result.nextCursor) {
    expect(requests++).toBeLessThan(10);
    result = await readPdf(fixture, { documentId: document.documentId, cursor: result.nextCursor });
    expect(result.pages).toEqual([1]);
    chunks.push(result.text);
  }

  const tokens = chunks.join("").match(/TOKEN\d{4}/g);
  expect(tokens).toEqual(denseLines.map((line) => line.slice(0, 9)));
  const text = chunks.join("").replace(/\s+/g, " ");

  for (const line of denseLines) expect(text).toContain(line);
});

test("selects physical PDF pages and sequential continuation stays on its source tab", async ({
  browserFixture: fixture,
}) => {
  await fixture.target.goto(`${fixture.fixtureUrl}pdf`);
  const document = await openPdf(fixture);
  const other = await fixture.context.newPage();
  await other.goto(fixture.fixtureUrl);
  await other.bringToFront();
  const selected = await readPdf(fixture, { documentId: document.documentId, pages: [4, 2, 2] });
  expect(selected.pages).toEqual([2, 4]);
  expect(selected.text).toContain("SECOND_PAGE_ONLY");
  expect(selected.text).toContain("FOURTH_PAGE_ONLY");
  expect(selected.text).not.toContain("THIRD_PAGE_ONLY");
  expect(selected.nextCursor).toBeNull();
  let result = await readPdf(fixture, { documentId: document.documentId });
  let requests = 0;

  while (result.nextCursor) {
    expect(requests++).toBeLessThan(10);
    result = await readPdf(fixture, { documentId: document.documentId, cursor: result.nextCursor });
  }

  expect(result.pages).toEqual([4]);
  expect(result.text).toContain("FOURTH_PAGE_ONLY");
  await fixture.target.goto(`${fixture.fixtureUrl}changed`);
  const stale = await fixture.readPdf({ documentId: document.documentId, pages: [2] });
  expect(stale.status).toBe(400);
  expect(await stale.json()).toMatchObject({ data: { code: "pdf_document_changed" } });
});

test("contains invalid PDF selections and reports textless pages without pretending they were read", async ({
  browserFixture: fixture,
}) => {
  await fixture.target.goto(`${fixture.fixtureUrl}pdf`);
  const document = await openPdf(fixture);
  const invalid = await fixture.readPdf({ documentId: document.documentId, pages: [999] });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({
    data: { code: "pdf_pages_invalid", message: expect.stringContaining("4 physical pages") },
  });
  expect((await readPdf(fixture, { documentId: document.documentId, pages: [2] })).text).toContain(
    "SECOND_PAGE_ONLY",
  );
  await fixture.target.goto(`${fixture.fixtureUrl}blank-pdf`);
  const blank = await openPdf(fixture);
  const result = await readPdf(fixture, { documentId: blank.documentId });
  expect(result.text).toBe("");
  expect(result.warnings).toContainEqual(
    expect.objectContaining({
      pages: [1],
      message: expect.stringContaining("No extractable text"),
    }),
  );
  expect(result.nextCursor).toBeNull();
});

test("keeps heartbeats alive during a slow PDF download without duplicating the job", async ({
  browserFixture: fixture,
}) => {
  const started = Effect.runSync(Deferred.make<void>());
  const release = Effect.runSync(Deferred.make<void>());
  let downloads = 0;
  let polls = 0;
  fixture.panel.on("request", (request) => {
    if (request.url().includes("/api/rpc/chrome/poll")) polls++;
  });
  await fixture.context.route(`${fixture.fixtureUrl}pdf`, async (route) => {
    if (route.request().resourceType() === "fetch") {
      downloads++;
      Effect.runSync(Deferred.succeed(started, undefined));
      await Effect.runPromise(Deferred.await(release));
    }

    await route.continue();
  });
  await fixture.target.goto(`${fixture.fixtureUrl}pdf`);
  const opening = openPdf(fixture);

  try {
    await Effect.runPromise(Deferred.await(started));
    const initialPolls = polls;
    await expect.poll(() => polls - initialPolls, { timeout: 18000 }).toBeGreaterThanOrEqual(10);
    Effect.runSync(Deferred.succeed(release, undefined));
    expect((await opening).pageCount).toBe(4);
    expect(downloads).toBe(1);
  } finally {
    Effect.runSync(Deferred.succeed(release, undefined));
    await opening.catch(() => undefined);
  }
});

test("retries result delivery without reading changed page content again", async ({
  browserFixture: fixture,
}) => {
  let attempts = 0;
  await fixture.context.route("**/api/rpc/chrome/complete?*", async (route) => {
    attempts++;

    if (attempts === 1) {
      await fixture.target.evaluate(() => {
        document.body.innerHTML =
          "<article><h1>Replacement article</h1><p>This content appeared after the read completed.</p></article>";
      });
    }

    if (attempts <= 2) {
      await route.abort("failed");

      return;
    }

    await route.continue();
  });
  const page = await readPage(fixture);
  expect(attempts).toBeGreaterThanOrEqual(3);
  expect(page.text).toContain("Chrome bridge works");
  expect(page.text).not.toContain("Replacement article");
});

test("reads a live blob PDF and contains revoked URL failures", async ({
  browserFixture: fixture,
}) => {
  const blob = await fixture.target.evaluate(
    (bytes) => URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" })),
    [...pagedPdf],
  );

  const viewer = await fixture.context.newPage();
  await viewer.goto(blob);
  await viewer.bringToFront();
  const document = await openPdf(fixture);
  expect((await readPdf(fixture, { documentId: document.documentId, pages: [4] })).text).toContain(
    "FOURTH_PAGE_ONLY",
  );
  await fixture.target.evaluate((url) => URL.revokeObjectURL(url), blob);
  const reopened = await fixture.read();
  expect(reopened.status).toBe(400);
  expect(await reopened.json()).toMatchObject({ data: { code: "pdf_unavailable" } });
  // The already-acquired snapshot remains readable while the PDF tab is unchanged.
  expect((await readPdf(fixture, { documentId: document.documentId, pages: [2] })).text).toContain(
    "SECOND_PAGE_ONLY",
  );
});

test("reports encrypted PDFs as password-required and recovers for another document", async ({
  browserFixture: fixture,
}) => {
  await fixture.target.goto(`${fixture.fixtureUrl}encrypted-pdf`);
  const response = await fixture.read();
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    data: { code: "pdf_password_required" },
  });
  await fixture.target.goto(`${fixture.fixtureUrl}pdf`);
  const document = await openPdf(fixture);
  expect((await readPdf(fixture, { documentId: document.documentId, pages: [4] })).text).toContain(
    "FOURTH_PAGE_ONLY",
  );
});
