# Upstream proposal: headless sidebar store adoption

Status: 2026-10-28, DSH Desktop 0.2.1-rc.3, `dsh-sidebar-control` 0.2.1.

## Problem

A plugin can read any Session's sidebar tabs (`ctx.sidebarRight.openTabs` is built from
saved layouts plus adopted stores), but it cannot *write* another Session's sidebar
without asking the app to show that Session first.

The public controller's navigation commands (`openTab`, `openResource`, `focus`, `close`)
resolve their target through `require()`:

```ts
// sidebar-right client, SidebarRightController
require() {
  const sessionId = this.mounted.getSnapshot();          // on-screen Session only
  const actions = sessionId === undefined ? undefined : this.actionsFor(sessionId);
  if (sessionId === undefined || actions === undefined) throw new Error(...)
  return { sessionId, actions };
}
actionsFor(sessionId) {
  return this.adopted.get(sessionId)?.store.actions;     // undefined until adopted
}
```

`adopted` is filled only by `adopt(sessionId, instance)`, called from the slot store
wrapper's `create(scopeKey)` when the session-scoped `rightbar.session` slot actually
renders. So a Session's sidebar store is minted lazily with its seat, and released when
the seat goes away.

The controller already has per-Session methods (`openTabIn`, `openResourceIn`, `closeIn`,
`tabsIn`) but they all no-op for a store that was never adopted (`actions === undefined`).

The only way for a plugin to force adoption today is to drive the app's own session
navigation (`ctx.uiWorkspace.openSession(sessionId)`), which visibly replaces the main
conversation view while the command runs. Measured on this build: the switch itself takes
~130–160 ms (`openSession` → `sidebarRight.mounted` reports the target), and restoring the
previous Session costs another render, so the user sees ~200–300 ms of another conversation.

Our workaround (`dsh-sidebar-control` 0.2.0/0.2.1) does exactly that: switch → act →
restore, and it reports the switch in the tool receipt. Two mitigations exist but neither
removes the first-touch flash:

- after one switch the Session's store stays adopted for the rest of the app run, so
  later operations on it are seamless (`status` marks those Sessions `live-store`);
- `switchView: false` refuses the visible switch instead of performing it.

## Proposal (any one is sufficient)

1. **Adopt on demand.** Add to the cross-plugin face:

   ```ts
   interface ISidebarRight {
     /** Mint/adopt a Session's saved layout store without rendering its seat. */
     ensureSessionStore(sessionId: SessionId): Promise<void>;
   }
   ```

   It would read the persisted layout (the same validation/clearing `readSidebarLayout`
   already performs), create the scoped store, register it with the controller's adoption
   map (inventory sync included), and keep it alive until the Session view is opened or
   the caller releases it. Existing `openTabIn`/`openResourceIn`/`closeIn` would then work
   headlessly with no new call sites.

2. **Make the per-Session methods adopt-on-demand** and document them as public:
   `openTabIn(sessionId, …)`, `openResourceIn(sessionId, …)`, `focusIn(sessionId, tabId)`,
   `closeIn(sessionId, tabId)`. They already take the session id; only the missing-store
   branch has to change from "return silently" to "adopt and continue".

3. **Expose the scoped store handle.** The sidebar-right plugin already wraps
   `@deepseek-ai/dsh-client-store`'s `defineStore` with `create(scopeKey)` (persisted-layout
   restore + persistence subscription). Providing that handle (or an equivalent
   `ctx.get('sidebarRightStore')`) plus `controller.adopt(...)` would let other plugins
   pre-warm and act without the UI.

## Why it matters

- Cross-Session sidebars become genuinely background work: no view flash, safe while the
  user is typing, usable in multi-agent runs where one Agent orchestrates several Sessions.
- Agents can pre-warm a Session (one switch, or no switch with this API) and then open,
  focus, close and inspect its tabs cheaply.
- Backward compatible: the on-screen path stays exactly as it is; adoption only reads a
  layout the app already validates at startup.

## Current fallback in dsh-sidebar-control

- `status` reads any Session, no switch.
- `expand` reads file/terminal metadata (and file content) without a switch.
- `open`/`focus`/`close` switch only when the target Session has no live store; receipts say
  which Sessions were shown/restored and how long the switch took.
- `switchView: false` turns a would-be switch into a clear error instead of a flash.
