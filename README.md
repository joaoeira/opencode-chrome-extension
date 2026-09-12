# OpenCode Chrome Sidebar

Use OpenCode beside the page you're reading—and let it read your browser tabs.

This Chrome extension puts the **OpenCode v2 web interface** in your browser's side panel. A companion plugin gives OpenCode two tools: one to list your tabs, and one to read a tab's content. Ask it to explain an article, compare two open pages, or use browser context while working with files in a local project.

The sidebar connects to your local OpenCode server, using its existing model providers, accounts, and sessions. It is the upstream OpenCode interface, with no separate chat UI or provider configuration to maintain.

**Early-stage project.** Installed manually as an unpacked extension. Native helper setup supports macOS and Linux; Windows is not supported yet.

## What you can do

Try asking:

> Summarize the article I'm reading.

> List my open tabs and find the two articles about inference.

> Read those two articles and compare their recommendations.

> Use this page as context to update the documentation in my project.

Page content is extracted locally with [Defuddle](https://github.com/kepano/defuddle) and returned as Markdown, preserving useful structure such as headings, links, and code blocks. Reading a background tab does not activate it.

The browser tools are read-only: they cannot click, type, navigate, or close tabs. OpenCode's existing tools handle local files and commands under your OpenCode configuration.

## How it works

There are three pieces:

- **Chrome extension:** displays the OpenCode web UI and reads tabs in the sidebar's window.
- **OpenCode plugin:** exposes the browser tools to models and routes requests to the extension.
- **Native helper:** lets Chrome discover and start your local OpenCode server without copying addresses or credentials.

When the model requests a page, the extension extracts it and sends the result to OpenCode. OpenCode includes that result in the next model request. Switching tabs alone does not send page content.

One connected sidebar serves **all projects and sessions on the same server**. Switching projects in OpenCode requires no browser reconnection. Keep the sidebar open while using browser tools; closing it disconnects browser access but leaves the server running.

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

| Tool                | Arguments                  | Result                                                                                   |
| ------------------- | -------------------------- | ---------------------------------------------------------------------------------------- |
| `browser_list_tabs` | `{}`                       | Tabs in the sidebar's window, in tab-strip order: `tabId`, `title`, `url`, and `active`. |
| `browser_read_page` | `{}` or `{ "tabId": 123 }` | The tab's `tabId`, `title`, `url`, and full extracted Markdown in `text`.                |

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

There is no character cap or `truncated` field. The plugin also bypasses OpenCode's automatic tool-output clipping. Your model's context-window limit still applies.

## Scope and data access

The extension requests access to HTTP and HTTPS pages so it can read tabs without a fresh permission prompt for every site. Chrome's site-access controls can restrict this access.

Extraction runs inside Chrome against the loaded page. Defuddle's external-fetch fallback is disabled. Extracted content is then passed to **the model provider selected in OpenCode**; local extraction does not mean local model processing.

Browser access is limited to the connected sidebar's window. Only one sidebar can own a server's browser connection at a time. While enabled, this plugin replaces OpenCode's desktop-only browser tools with these Chrome tools.

The reader extracts the page's main content, not every part of its DOM. It does not read PDFs, browser-internal pages, canvas content, cross-origin frames, or closed shadow roots. Tab listings can include pages that cannot be read. Content extraction can omit navigation, comments, or other material Defuddle treats as nonessential.

The server connection is restricted to loopback HTTP. Credentials stay out of iframe URLs and are held in Chrome's session storage. Website content is returned as tool data, not as trusted instructions.

## Troubleshooting

**The sidebar is blank or doesn't connect.** Run `bun run setup` again, then click **Reload** on the extension's card in `chrome://extensions` and reopen the sidebar. Check for an unanswered macOS filesystem prompt. To start or discover the service from the terminal, run `bun run dev`.

**The model doesn't have the browser tools.** Check the absolute plugin path in your global OpenCode configuration and restart the server. The plugin must be enabled for the project your chat uses.

**A tool says no sidebar is connected.** Keep the sidebar open and close any other OpenCode sidebars connected to that server. After updating this repository, rebuild and reload the extension as well as restarting the server.

**A particular tab cannot be read.** Check the extension's site-access permission in Chrome. Browser-internal pages and PDFs are unsupported. If the tab was closed, list tabs again to obtain a current ID.

**Providers or sessions differ from your terminal.** Confirm both clients use OpenCode v2 and the same configuration and data directories. Setup captures `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME`; rerun it after changing those variables.

The sidebar contains only the OpenCode iframe. Connection failures are logged to the extension's console while it retries automatically. For diagnostics, inspect the sidebar through Chrome's developer tools or check the extension's **Errors** entry in `chrome://extensions` if one appears.

## Development

The project uses TypeScript, Effect v4, Bun, and esbuild. The extension and plugin share validated RPC contracts.

| Directory    | Purpose                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `extension/` | Side panel, browser access, authentication, and bundled Defuddle extractor.       |
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

Integration tests use separate OpenCode servers and temporary Chromium profiles. Model requests go to a local fake provider, so the tests do not spend model credits. They cover tab selection, background reads, window boundaries, connection recovery, full-content delivery, and tool calls across projects. The automated UI tests open the sidebar document as an extension tab; Chrome's native side-panel activation remains a manual check.

After changing extension code, run `bun run build` and reload the extension in Chrome. After changing plugin code, restart OpenCode. `bun run dev` ensures the background service is running and then exits; it is not a file watcher.

Contributions should include tests for observable behavior or failure handling, rather than implementation details. Run the checks above before submitting a change. See [AGENTS.md](AGENTS.md) for code and test conventions. The vendored [anti-slop lint rules](tools/oxlint/anti-slop/UPSTREAM.md) apply to both generic TypeScript and Effect code.

For nonstandard setups, `OPENCODE_CHROME_HOST_DIRECTORY` overrides the native host registration directory, `OPENCODE_CHROME_PORT` sets a startup port, and `CHROMIUM_EXECUTABLE` selects the browser executable used by integration tests.
