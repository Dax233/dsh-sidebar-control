# dsh-sidebar-control

Agent-facing control plane for the DSH right Sidebar. One tool (`sidebar`) plus a compact
system-prompt overview, over a registry of tab kinds rather than a second browser.

The DSH right Sidebar holds tabs of several kinds: the built-in browser, the terminal, file
previews, plugins' own pages. This plugin gives the model a **hierarchical overview** of that
workspace and the navigation verbs — open / focus / close / expand — while the per-kind content
actions stay with the tools that own them (browser pages with `browser_*`, files with the file
tools, terminals with `terminal_*`).

```
sidebar status                     → tree: tabId, kind, title, url/path, active, mounted
sidebar open {kind:"browser", url} → opens the user-visible in-app browser tab
sidebar open {kind:"file", path}   → opens a document-preview tab (line: source line)
sidebar open {kind:"terminal"}     → opens a visible terminal tab
sidebar expand {tabId}             → pulls that tab's content + names the exact tools for it
sidebar focus / close {tabId}      → navigation verbs
```

## Why this exists (and what it does not do)

DSH's built-in sidebar browser ships **user-facing only** — it registers no model tools. The
ecosystem now has solid MIT plugins that bolt agent control onto it; this plugin is designed to
compose with them instead of competing:

- **browser tab content** is read/clicked by `dsh-agent-browser` (`browser_read`,
  `browser_act`, `browser_screenshot`, `browser_navigate`, …). `sidebar expand` on a browser tab
  asks that plugin's Client provider for the page text and hands the tabId over.
- **file tabs** are opened through the document-preview resource address
  (`dsh-resource://file/session/<sessionId>/<path>`); `expand` returns a bounded text excerpt and
  the real path, and the file tools do the rest.
- **terminal tabs** are opened through the Sidebar terminal type; `expand` names the
  `terminal_*` tools. v0.1 does **not** claim identity between a visible terminal tab and a
  `terminal_*` tool session — it says so instead of pretending.
- **unknown kinds** (other plugins' pages) are inventory-only: listed, focusable, closable, but
  not readable.

What this plugin does not do: it never creates a webview, never starts a loopback bridge, and
never re-implements page reading. It talks to the renderer through the Cordis Inspect channel
(one Client provider, `SidebarControl`) and to the Sidebar through the public
`ctx.sidebarRight` service.

## Platform facts

- **The Sidebar is per Session.** Commands act on the Session whose Sidebar is on screen; a
  Session whose sidebar store was never adopted has nothing to act on, and the tool reports that
  ("not on screen") instead of writing into a surface nobody is drawing.
- **The desktop shell isolates the in-app browser from the DSH Host.** `sidebar open
  {kind:"browser"}` mirrors that policy before the browser plugin could surface a bare
  `ERR_FAILED (-2)`: any loopback hostname on the DSH Host port is refused with an explicit
  policy error. `file://` is unavailable by design; file tabs go through the resource address.
- **Progressive disclosure.** The prompt section lists at most a handful of tabs as an overview;
  full content and the exact follow-up tools appear only in `sidebar expand` results, so the
  context budget follows actual need.

## Install

```sh
dsh plugin --profile desktop add file:F:/github/dsh-sidebar-control
```

Or through the Plugins page. The bundle patch mounts the Host half; `package.json`'s
`dsh.client` loads the renderer half. Restart DSH Desktop after installation (or let the plugin
manager apply the bundle live).

Recommended companion (browser content): `github:guanhaisen/dsh-agent-browser`.

## Configuration

Optional, in the profile `cordis.patch.yml`:

```yaml
- id: dsh-sidebar-control
  name: dsh-sidebar-control
  config:
    maxPromptTabs: 8      # tabs rendered in the system-prompt overview
    maxTreeTabs: 40       # tabs rendered by sidebar status
    maxExpandChars: 4000  # expand content budget (200..20000)
    maxFileBytes: 524288  # files larger than this are not excerpted
```

## Model experience

One tool (`sidebar`), plus a short prompt section that names the workflow and the last seen tab
tree. Results are plain text trees/receipts; nothing is injected into the conversation beyond
what the model asks for. The tool never touches page content itself, so prompt-injection surface
stays with the tools that do (and those already wrap page content as untrusted data).

## License

MIT.
