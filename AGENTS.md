# Project conventions

Use Effect v4, pinned to the version compatible with this OpenCode release. Apply the installed `effect` skill when available. Use Schema at untrusted boundaries, tagged errors, named Effects, Context.Service/Layer for capabilities, scoped lifetimes, and Schedule for polling. Keep native browser callbacks and test-driver promises at adapter boundaries.

Run `bun run check` after changes. Run `bun run test:browser` for changes to the extension, authentication, RPC, or plugin lifecycle. Tests use real seams and Effect TestClock; do not add module mocks or timing sleeps.

All generic and Effect anti-slop rules are enabled. Do not disable or weaken them to accommodate new code. Preserve the vendored rules and provenance. Format with `bun run format` after lint whitespace autofixes.

Keep credentials, runtime data, and generated artifacts out of Git. List and read only tabs in the sidebar's own window. A page read without tabId resolves the active tab anew; an explicit tabId must never fall back to another tab or activate it. Return title, URL, and tab ID. Offer model tools only to the connected sidebar's visible session; a switch cancels pending work from the previous session. Preserve connection ownership, full Defuddle Markdown output, deadlines, and cleanup. Page reads identify PDFs as metadata only. PDF reads accept a tabId to open or reuse and read a snapshot, or a documentId to read an existing snapshot; cursor continuation requires the documentId. Page batches return plain results with lossless, repeatable cursors. Keep heartbeats independent of extraction, deduplicate pending jobs, and bind PDF snapshots to their session and source document.

Tests must pin down caller-visible outcomes, ordering, or failure containment. Prefer focused public-output assertions to whole-object equality. Do not add production seams solely for tests. Avoid duplicate coverage through another call site. For subtle guarantees, temporarily break the implementation and confirm the focused test fails, then restore it.
