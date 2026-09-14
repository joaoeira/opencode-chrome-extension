# OpenCode Chrome Sidebar

Use OpenCode beside the page you're reading—and let it read your browser tabs.

This Chrome extension puts the **OpenCode v2 web interface** in your browser's side panel. A companion plugin gives OpenCode tools to list your tabs, read HTML, and read selected PDF pages. Ask it to explain an article, compare two open pages, or use browser context while working with files in a local project.

The sidebar connects to your local OpenCode server, using its existing model providers, accounts, and sessions. It is the upstream OpenCode interface, with no separate chat UI or provider configuration to maintain.

**Early-stage project.** Installed manually as an unpacked extension. Native helper setup supports macOS and Linux; Windows is not supported yet.

## What you can do

Try asking:

> Summarize the article I'm reading.

> List my open tabs and find the two articles about inference.

> Read those two articles and compare their recommendations.

> Use this page as context to update the documentation in my project.

HTML content is extracted locally with [Defuddle](https://github.com/kepano/defuddle) and returned as Markdown, preserving useful structure such as headings, links, and code blocks. Reading a background tab does not activate it. PDFs use [pdf-inspector](https://github.com/firecrawl/pdf-inspector) locally in Chrome; the model requests the pages it needs.

The browser tools are read-only: they cannot click, type, navigate, or close tabs. OpenCode's existing tools handle local files and commands under your OpenCode configuration.

## How it works

There are three pieces:

- **Chrome extension:** displays the OpenCode web UI and reads tabs in the sidebar's window.
- **OpenCode plugin:** exposes the browser tools to models and routes requests to the extension.
- **Native helper:** lets Chrome discover and start your local OpenCode server without copying addresses or credentials.

When the model requests a page, the extension extracts it and sends the result to OpenCode. OpenCode includes that result in the next model request. Switching tabs alone does not send page content.

The browser connection is shared across projects, but browser tools are offered only to **the session currently open in the sidebar**. Switching sessions moves access with the sidebar; returning to the home screen removes it. Other terminal sessions do not see these tools. If you open the same session in the terminal and sidebar, it has browser access in both places. Closing the sidebar removes access when it disconnects or its heartbeat expires (within eight seconds), and leaves the server running. Previously returned page content stays in the conversation.

## Installation

### Requirements

- [Bun](https://bun.sh/).
- Google Chrome 116 or newer, on macOS or Linux. The installer also registers the helper for Chromium and Chrome for Testing.
- A model provider configured in OpenCode, or one you can connect through its UI.

This checkout includes OpenCode **2.0.2** as a dependency. If you also use OpenCode in your terminal, use the same v2 build and configuration paths so both clients share the same service. OpenCode v1 is not supported.

### 1. Build and register the extension

Clone or download this repository, then run these commands from its root:

```sh
bun install
bun run setup
```

Setup builds `dist/extension` and registers the local helper with Chrome. Keep the checkout where it is: the helper's launcher refers to its absolute path. Rerun setup if you move the checkout or your Bun installation.

### 2. Enable the OpenCode plugin

Add the plugin's **absolute path** to the `plugins` array in your global OpenCode configuration, normally `~/.config/opencode/opencode.json`. Create the file if it doesn't exist; otherwise preserve your existing settings and plugin entries.

```json
{
  "plugins": ["/absolute/path/to/opencode-chrome-extension/plugin"]
}
```

Use the global configuration so the browser tools are available across projects. This path points to `plugin`, not `dist/extension`.

If OpenCode is already running, restart it from the repository root:

```sh
./node_modules/.bin/opencode service restart
```

### 3. Load it in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this repository's `dist/extension` directory.
3. Open a web page, then click **OpenCode Sidebar** in Chrome's Extensions menu. You can pin it to the toolbar for easier access.

The sidebar finds the local server and starts it if necessary. There is no connection file to import and no separate sign-in for the extension. Connect a model provider in OpenCode if you haven't already, open a chat, and ask:

> Use browser_read_page to summarize my current tab.

On macOS, a filesystem permission prompt may appear if the checkout is in Documents or another protected folder. The helper cannot start until that prompt is answered.

## Browser tools

| Tool                | Arguments                                                                          | Result                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `browser_list_tabs` | `{}`                                                                               | Tabs in the sidebar's window, in tab-strip order: `tabId`, `title`, `url`, and `active`.                       |
| `browser_read_page` | `{}` or `{ "tabId": 123 }`                                                         | Full HTML Markdown, or PDF metadata (`type`, `documentId`, `tabId`, `title`, `url`, `pageCount`) without text. |
| `browser_read_pdf`  | `{ "documentId": "…", "pages": [1, 3] }` or `{ "documentId": "…", "cursor": "…" }` | Selected PDF text with source pages and `nextCursor`.                                                          |

Omit `tabId` to read the active tab at the time of the call. Pass an ID from the tab listing to read a specific tab without switching to it. A closed tab or a tab in another window returns an error; it never falls back to a different tab.

A page result looks like this:

```json
{
  "tabId": 123,
  "title": "An example article",
  "url": "https://example.com/article",
  "text": "## Introduction\n\nThe article's content, with **formatting** and [links](https://example.com)."
}
```

HTML results have no character cap or `truncated` field. The plugin also bypasses OpenCode's automatic tool-output clipping. Your model's context-window limit still applies.

### Reading PDFs

`browser_read_page` identifies a top-level PDF and returns metadata only. The model then calls `browser_read_pdf` with that `documentId` and either physical page numbers (starting at 1), or a returned cursor. Printed page labels can differ from physical page numbers. With neither `pages` nor `cursor`, reading begins at page 1 and continues sequentially.

```json
{
  "documentId": "pdf-id-from-browser_read_page",
  "tabId": 123,
  "title": "Annual report",
  "url": "https://example.com/report.pdf",
  "pageCount": 120,
  "pages": [28, 29, 30],
  "text": "<!-- Page 28 -->\n\n# Energy demand\n\n…",
  "nextCursor": null
}
```

Each batch selects at most three pages. Responses contain at most 24,000 UTF-16 code units of Markdown, without splitting surrogate pairs. Longer text is continued through `nextCursor` before advancing to the next batch; no extracted text is silently clipped. The `pages` field identifies the source batch, not the exact page boundaries of a split text portion. Repeating a cursor returns the same portion. For an explicit selection, a null cursor means those requested pages are finished; otherwise it means the sequential document read is finished.

Requests accept up to 20 page numbers, normalized to unique document order. Page 0, out-of-range pages, and supplying both pages and cursor are errors. Documents remain tied to the source tab and OpenCode session. Switching active tabs does not retarget them; source navigation, closure, movement to another window, a session change, or disconnect requires reopening the PDF.

The extension retains at most two PDF snapshots for ten minutes, with a 250 MiB download limit per file. It fetches the document again using Chrome's available credentials; that snapshot may differ from an older version still displayed in the viewer. Ordinary HTTP PDFs, cookie-authenticated PDFs, and live HTTP-origin blob URLs are supported. Expired or revoked URLs, POST-only documents, local files, and custom HTML PDF viewers may be inaccessible. No automatic download/save fallback is used.

Extraction uses packaged WebAssembly, with no Firecrawl API key or PDF upload. Encrypted PDFs return a password-required error. Scanned or textless pages produce warnings; OCR is not included. Download/parsing calls have a 60-second deadline. Large or unusually complex PDFs can be slow and use considerable memory; parsing runs separately from the connection heartbeat.

## Scope and data access

The extension requests access to HTTP and HTTPS pages so it can read tabs without a fresh permission prompt for every site. Chrome's site-access controls can restrict this access. Its content security policy permits HTTP(S) connections to fetch PDFs; the OpenCode server connection is still restricted to loopback addresses by `localOrigin` validation.

HTML extraction runs inside Chrome against the loaded page. Defuddle's external-fetch fallback is disabled. Extracted content is then passed to **the model provider selected in OpenCode**; local extraction does not mean local model processing.

Browser access is limited to the connected sidebar's window. Only one sidebar can own a server's browser connection at a time. While enabled, this plugin replaces OpenCode's desktop-only browser tools with these Chrome tools.

The reader extracts the page's main content, not every part of its DOM. It does not read browser-internal pages, canvas content, cross-origin frames, or closed shadow roots. Tab listings can include pages that cannot be read. Content extraction can omit navigation, comments, or other material Defuddle treats as nonessential.

The server connection is restricted to loopback HTTP. Credentials stay out of iframe URLs and are held in Chrome's session storage. Website content is returned as tool data, not as trusted instructions.

## Troubleshooting

**The sidebar is blank or doesn't connect.** Run `bun run setup` again, then click **Reload** on the extension's card in `chrome://extensions` and reopen the sidebar. Check for an unanswered macOS filesystem prompt. To start or discover the service from the terminal, run `bun run dev`.

**The model doesn't have the browser tools.** Check the absolute plugin path in your global OpenCode configuration and restart the server. The plugin must be enabled for the project your chat uses, and the chat must be the session currently displayed in the connected sidebar.

**A tool says no sidebar is connected.** Keep the sidebar open and close any other OpenCode sidebars connected to that server. After updating this repository, rebuild and reload the extension as well as restarting the server.

**A particular tab cannot be read.** Check the extension's site-access permission in Chrome. Browser-internal pages are unsupported. For PDFs, check the retrieval error or OCR warning. If the tab was closed, list tabs again to obtain a current ID.

**Providers or sessions differ from your terminal.** Confirm both clients use OpenCode v2 and the same configuration and data directories. Setup captures `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME`; rerun it after changing those variables.

The sidebar contains only the OpenCode iframe. Connection failures are logged to the extension's console while it retries automatically. For diagnostics, inspect the sidebar through Chrome's developer tools or check the extension's **Errors** entry in `chrome://extensions` if one appears.

## Development

The project uses TypeScript, Effect v4, Bun, and esbuild. The extension and plugin share validated RPC contracts.

| Directory    | Purpose                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `extension/` | Side panel, browser access, authentication, and bundled HTML/PDF extractors.      |
| `plugin/`    | Model tools and the server-wide request queue.                                    |
| `shared/`    | Schemas and RPC definitions shared by both sides.                                 |
| `scripts/`   | Build, native helper installation, and local service management.                  |
| `tests/`     | Bridge, native messaging, browser integration, and model-provider boundary tests. |

```sh
# Typecheck, lint, check formatting, run unit tests, and build
bun run check

# Install the test browser and run integration tests
bunx playwright install chromium
bun run test:browser
```

Integration tests use separate OpenCode servers and temporary Chromium profiles. Model requests go to a local fake provider, so the tests do not spend model credits. They cover tab selection, background reads, window boundaries, connection recovery, full-content delivery, tool calls across projects, PDF metadata/page selection/cursors, slow-download heartbeats, and tool visibility as the sidebar opens, switches sessions, returns home, and closes. The automated UI tests open the sidebar document as an extension tab; Chrome's native side-panel activation remains a manual check.

PDF limits live in `shared/pdf.ts`. Worker calls have a 60-second deadline, document operations allow another five seconds for cleanup, and the bridge allows five more for delivery. Because `browser_read_page` discovers the content type in Chrome, its bridge deadline also applies to HTML requests; HTML extraction itself still times out after five seconds. If a sidebar disappears without releasing its connection and no other call checks its heartbeat, the pending read can wait for that bridge deadline.

After changing extension code, run `bun run build` and reload the extension in Chrome. After changing plugin code, restart OpenCode. `bun run dev` ensures the background service is running and then exits; it is not a file watcher.

Contributions should include tests for observable behavior or failure handling, rather than implementation details. Run the checks above before submitting a change. See [AGENTS.md](AGENTS.md) for code and test conventions. The vendored [anti-slop lint rules](tools/oxlint/anti-slop/UPSTREAM.md) apply to both generic TypeScript and Effect code.

For nonstandard setups, `OPENCODE_CHROME_HOST_DIRECTORY` overrides the native host registration directory, `OPENCODE_CHROME_PORT` sets a startup port, and `CHROMIUM_EXECUTABLE` selects the browser executable used by integration tests.
