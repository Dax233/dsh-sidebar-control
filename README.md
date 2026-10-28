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
sidebar open {kind:"browser", url}        → opens the user-visible in-app browser tab
sidebar open {kind:"browser", url, tabId} → navigates that existing browser tab in place
sidebar open {kind:"file", path, line?}   → document-preview tab (relative paths resolve against the Session directory)
sidebar open {kind:"terminal"}            → opens a visible terminal tab
sidebar expand {tabId, mode?}             → content + the exact tools for it (mode: text/elements/html on browser tabs)
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
- **Another Session is reachable (0.2.x).** Pass `sessionId` to `status`/`open`/`focus`/`close`/`expand`.
  Read-only `status` needs no switch. Navigation commands write through the target Session's
  **live sidebar store** when it has one (`status` marks that Session `live-store`) and therefore
  do not touch the view at all; a Session that has not been displayed since the app started has
  no live store, so the app is asked to show it (the same path a session-row click takes) and then
  restores the previous Session — receipts say which Sessions were involved and how long the
  switch took (measured ~130–160 ms on 0.2.1-rc.3, so roughly 200–300 ms of another conversation).
  The first operation on such a Session warms its store: every later operation on it is seamless
  for the rest of the app run. `switchView: false` refuses the visible switch instead of flashing
  the view (useful for Agents that must not disturb the user). `expand` of a file tab works
  without a switch (the Host reads the file directly) and relative paths resolve against the
  target Session's working directory. Two further limits stay, both from the adopted browser
  plugin's session-scoped contract: the **content** of another Session's browser tab cannot be
  read (only its metadata is returned), and an existing browser tab of another Session cannot be
  navigated by `tabId` (open a new tab there instead). **Why the first-touch switch cannot be
  removed from this side**, and the upstream API that would remove it, are documented in
  [`docs/upstream-sidebar-store.md`](docs/upstream-sidebar-store.md).

## Install

```sh
dsh plugin --profile desktop add github:Dax233/dsh-sidebar-control
```

Or through the Plugins page (`github:Dax233/dsh-sidebar-control`). The bundle patch mounts the
Host half; `package.json`'s `dsh.client` loads the renderer half. The plugin manager can apply the
bundle live; otherwise restart DSH Desktop.

Local development install (a `file:` copy, so reinstall after edits):

```sh
dsh plugin --profile desktop add file:F:/github/dsh-sidebar-control
```

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



