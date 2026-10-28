import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const clientFile = join(here, '..', 'client.js')

/** Minimal DOM element stand-in for one tab wrapper (with an optional browser guest). */
function makeWrapper(tabId, options = {}) {
  const guest =
    options.guest === false
      ? undefined
      : {
          getURL: () => options.url ?? 'https://example.com/',
          getTitle: () => options.title ?? 'Example Domain',
        }
  return {
    dataset: { sidebarRightTab: tabId },
    hidden: options.hidden === true,
    parentElement: null,
    getBoundingClientRect: () => ({ width: options.width ?? 640, height: options.height ?? 480 }),
    getAttribute: () => (options.ariaHidden === true ? 'true' : null),
    querySelector: (selector) => (String(selector).startsWith('webview') ? guest ?? null : null),
    querySelectorAll: () => [],
  }
}

/** Load the real client bundle in a VM and return its plugin object. */
function loadClient(options = {}) {
  const wrappers = options.wrappers ?? []
  const document = {
    querySelectorAll: (selector) => (String(selector).includes('[data-sidebar-right-tab]') ? [...wrappers] : []),
    querySelector: () => null,
  }
  let registration
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          registration = definition
        },
      },
    },
    document,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
  }
  sandbox.globalThis = sandbox
  const context = createContext(sandbox)
  runInContext(readFileSync(clientFile, 'utf8'), context, { filename: clientFile })
  assert.ok(registration, 'client.js must register exactly one module')
  const plugin = registration.factory(() => {
    throw new Error('the sidebar control client half must not require sibling modules')
  })
  return { plugin, registration }
}

/** A fake ctx.sidebarRight plus captured navigation calls. */
function makeSidebar(options = {}) {
  const state = {
    inventory: options.inventory ?? [],
    committed: options.committed ?? [],
    onScreen: options.onScreen ?? 's1',
    activeId: options.activeId ?? 'tab1',
    expanded: options.expanded ?? true,
  }
  const calls = { openTab: [], openResource: [], focus: [], close: [], openTabIn: [], openResourceIn: [], closeIn: [], focusTab: [] }
  state.adopted = options.adopted ?? []
  state.actions = {
    focusTab(sessionId, tabId) {
      calls.focusTab.push({ sessionId, tabId })
    },
  }
  const sidebarRight = {
    openTabs: { getSnapshot: () => state.inventory },
    tabsIn: () => state.committed,
    mounted: { getSnapshot: () => state.onScreen },
    isExpanded: () => state.expanded,
    active: () => ({ id: state.activeId }),
    openTab(kind, openOptions) {
      calls.openTab.push({ kind, options: openOptions })
      if (typeof options.onOpenTab === 'function') state.inventory = options.onOpenTab(kind, openOptions, state.inventory)
    },
    openResource(address, resourceOptions) {
      calls.openResource.push({ address, options: resourceOptions })
      if (typeof options.onOpenResource === 'function') state.inventory = options.onOpenResource(address, resourceOptions, state.inventory)
    },
    focus(tabId) {
      calls.focus.push(tabId)
    },
    close(tabId) {
      calls.close.push(tabId)
    },
    openTabIn(sessionId, kind, openOptions) {
      calls.openTabIn.push({ sessionId, kind, options: openOptions })
      if (typeof options.onOpenTabIn === 'function') state.inventory = options.onOpenTabIn(sessionId, kind, openOptions, state.inventory)
    },
    openResourceIn(sessionId, address, resourceOptions) {
      calls.openResourceIn.push({ sessionId, address, options: resourceOptions })
      if (typeof options.onOpenResourceIn === 'function') state.inventory = options.onOpenResourceIn(sessionId, address, resourceOptions, state.inventory)
    },
    closeIn(sessionId, tabId) {
      calls.closeIn.push({ sessionId, tabId })
      state.inventory = state.inventory.filter((entry) => !(entry.sessionId === sessionId && entry.tabId === tabId))
      state.committed = state.committed.filter((entry) => !(entry.sessionId === sessionId && entry.id === tabId))
    },
    actionsFor(sessionId) {
      return state.adopted.includes(sessionId) ? state.actions : undefined
    },
  }
  return { sidebarRight, calls, state }
}

function makeProvider(options = {}) {
  const { plugin } = loadClient(options)
  const registered = []
  const ctx = {
    sidebarRight: options.sidebarRight,
    cordisInspect: {
      register(provider) {
        registered.push(provider)
        return () => {}
      },
    },
    get(key) {
      return key === 'uiWorkspace' ? options.uiWorkspace : undefined
    },
    effect(execute) {
      return execute()
    },
  }
  plugin.apply(ctx)
  const provider = registered[0]
  return { plugin, ctx, provider, manifest: provider.manifest }
}

const SESSION = { sessionId: 's1' }

/** Normalize a VM-realm value for cross-realm deepEqual. */
const json = (value) => JSON.parse(JSON.stringify(value))

test('client: apply registers one inspect provider with the documented methods', () => {
  const { sidebarRight } = makeSidebar()
  const { manifest, plugin } = makeProvider({ sidebarRight })
  assert.equal(plugin.name, 'dsh-sidebar-control')
  assert.deepEqual(json(plugin.inject), ['cordisInspect', 'sidebarRight'])
  assert.equal(manifest.id, 'SidebarControl')
  assert.deepEqual(json(manifest.methods.map((method) => method.name)), ['status', 'open', 'focus', 'close', 'expand', 'switch', 'restore'])
})

test('client: status describes identity, mount state and browser guest URL/title', async () => {
  const { sidebarRight } = makeSidebar({
    inventory: [
      { sessionId: 's1', tabId: 'tab1', kind: 'browser', contentId: 'page/browser/x' },
      { sessionId: 's1', tabId: 'tab2', kind: 'terminal', contentId: 'page/terminal/y' },
      { sessionId: 's2', tabId: 'tab9', kind: 'browser', contentId: 'page/browser/z' },
    ],
    committed: [
      { id: 'tab1', kind: 'browser', title: 'Committed title', contentId: 'page/browser/x' },
      { id: 'tab2', kind: 'terminal', title: 'pwsh', contentId: 'page/terminal/y' },
    ],
  })
  const { provider } = makeProvider({
    sidebarRight,
    wrappers: [makeWrapper('tab1', { url: 'https://example.com/', title: 'Example Domain' })],
  })
  const data = await provider.query('status', {}, SESSION)
  assert.equal(data.requestedSessionId, 's1')
  assert.equal(data.onScreen, true)
  assert.equal(data.onScreenSessionId, 's1', 'status names the Session whose Sidebar is on screen')
  assert.equal(data.sessions.length, 1, 'without includeAllSessions only the requesting Session is described')
  const tabs = data.sessions[0].tabs
  assert.equal(tabs.length, 2)
  assert.deepEqual(
    { tabId: tabs[0].tabId, kind: tabs[0].kind, title: tabs[0].title, url: tabs[0].url, mounted: tabs[0].mounted, active: tabs[0].active, hasGuest: tabs[0].hasGuest },
    { tabId: 'tab1', kind: 'browser', title: 'Example Domain', url: 'https://example.com/', mounted: true, active: true, hasGuest: true },
  )
  assert.equal(tabs[1].tabId, 'tab2')
  assert.equal(tabs[1].mounted, false, 'a tab without a wrapper is unmounted')
  assert.equal(tabs[1].title, 'pwsh', 'committed titles fill in non-browser tabs')
})

test('client: status includeAllSessions lists the other Sessions too', async () => {
  const { sidebarRight } = makeSidebar({
    inventory: [
      { sessionId: 's1', tabId: 'tab1', kind: 'browser', contentId: 'a' },
      { sessionId: 's2', tabId: 'tab9', kind: 'file', contentId: 'dsh-resource://file/session/s2/C:/tmp/a.md' },
    ],
    committed: [{ id: 'tab9', kind: 'file', title: 'a.md', contentId: 'dsh-resource://file/session/s2/C:/tmp/a.md' }],
  })
  const { provider } = makeProvider({ sidebarRight })
  const data = await provider.query('status', { includeAllSessions: true }, SESSION)
  assert.equal(data.sessions.length, 2)
  const fileTab = data.sessions.find((session) => session.sessionId === 's2').tabs[0]
  assert.equal(fileTab.kind, 'file')
  assert.equal(fileTab.path, 'C:/tmp/a.md')
})

test('client: open browser calls openTab with the validated URL and returns the new tab id', async () => {
  const { sidebarRight, calls } = makeSidebar({
    onOpenTab: (kind) => [{ sessionId: 's1', tabId: 'tabNew', kind, contentId: 'page/browser/new' }],
  })
  const { provider } = makeProvider({ sidebarRight })
  const data = await provider.query('open', { kind: 'browser', url: 'https://example.com/' }, SESSION)
  assert.equal(data.kind, 'browser')
  assert.equal(data.tabId, 'tabNew')
  assert.equal(data.pending, false)
  assert.deepEqual(json(calls.openTab), [{ kind: 'browser', options: { params: { url: 'https://example.com/' } } }])
})

test('client: open file builds the session resource address and forwards the line', async () => {
  const { sidebarRight, calls } = makeSidebar({
    onOpenResource: () => [{ sessionId: 's1', tabId: 'tabFile', kind: 'file', contentId: 'x' }],
  })
  const { provider } = makeProvider({ sidebarRight })
  const data = await provider.query('open', { kind: 'file', path: 'C:\\dir\\notes.md', line: 7 }, SESSION)
  assert.equal(data.tabId, 'tabFile')
  assert.equal(calls.openResource.length, 1)
  assert.equal(calls.openResource[0].address, 'dsh-resource://file/session/s1/C:/dir/notes.md')
  assert.deepEqual(json(calls.openResource[0].options), { params: { line: 7 } })
})

test('client: open terminal and guide use their kinds', async () => {
  const { sidebarRight, calls } = makeSidebar({ onOpenTab: (kind) => [{ sessionId: 's1', tabId: `tab-${kind}`, kind, contentId: 'x' }] })
  const { provider } = makeProvider({ sidebarRight })
  await provider.query('open', { kind: 'terminal', shellPath: 'C:\\Windows\\System32\\cmd.exe' }, SESSION)
  await provider.query('open', { kind: 'guide' }, SESSION)
  assert.deepEqual(json(calls.openTab.map((call) => call.kind)), ['terminal', 'guide'])
  assert.deepEqual(json(calls.openTab[0].options), { params: { shellPath: 'C:\\Windows\\System32\\cmd.exe' } })
  assert.deepEqual(json(calls.openTab[1].options), {})
})

test('client: status for an off-screen Session is read-only and never borrows the on-screen state', async () => {
  const { sidebarRight } = makeSidebar({ onScreen: 's2', inventory: [{ sessionId: 's1', tabId: 'tab1', kind: 'browser', contentId: 'a' }] })
  const { provider } = makeProvider({ sidebarRight })
  const status = await provider.query('status', {}, SESSION)
  assert.equal(status.onScreen, false)
  assert.equal(status.onScreenSessionId, 's2')
  assert.equal(status.sessions[0].onScreen, false)
  assert.equal(status.sessions[0].expanded, undefined, 'expanded comes from the on-screen Session and must not be attributed to another Session')
  assert.equal(status.sessions[0].activeTabId, undefined, 'activeTabId comes from the on-screen Session and must not be attributed to another Session')
})

test('client: a command for an off-screen Session switches the app to it and restores the previous one', async () => {
  const { sidebarRight, state, calls } = makeSidebar({ onScreen: 's2', inventory: [{ sessionId: 's1', tabId: 'tab1', kind: 'browser', contentId: 'a' }] })
  const opened = []
  const uiWorkspace = { openSession: (sessionId) => { opened.push(sessionId); state.onScreen = sessionId } }
  const { provider } = makeProvider({ sidebarRight, uiWorkspace })
  const data = await provider.query('focus', { tabId: 'tab1' }, SESSION)
  assert.deepEqual(json(opened), ['s1', 's2'], 'show the target Session, then restore the previous one')
  assert.equal(data.switched, true)
  assert.equal(data.previousSessionId, 's2')
  assert.equal(state.onScreen, 's2', 'the UI ends on the Session it started from')
  assert.deepEqual(json(calls.focus), ['tab1'])
})

test('client: without the app session switcher an off-screen command fails clearly', async () => {
  const { sidebarRight } = makeSidebar({ onScreen: 's2', inventory: [{ sessionId: 's1', tabId: 'tab1', kind: 'browser', contentId: 'a' }] })
  const { provider } = makeProvider({ sidebarRight })
  await assert.rejects(() => provider.query('focus', { tabId: 'tab1' }, SESSION), /session switcher \(ctx\.uiWorkspace\) is unavailable/u)
})

test('client: switchView:false refuses a visible switch for an off-screen Session', async () => {
  const { sidebarRight } = makeSidebar({ onScreen: 's1', inventory: [{ sessionId: 's2', tabId: 'tab1', kind: 'browser', contentId: 'a' }] })
  const { provider } = makeProvider({ sidebarRight, uiWorkspace: { openSession: () => {} } })
  await assert.rejects(() => provider.query('focus', { tabId: 'tab1', sessionId: 's2', switchView: false }, SESSION), /needs a temporary view switch/u)
})

test('client: switch reports how long the view switch took', async () => {
  const { sidebarRight, state } = makeSidebar({ onScreen: 's1', inventory: [{ sessionId: 's2', tabId: 'tab1', kind: 'guide', contentId: 'sidebar://guide' }] })
  const uiWorkspace = { openSession: (sessionId) => { state.onScreen = sessionId } }
  const { provider } = makeProvider({ sidebarRight, uiWorkspace })
  const data = await provider.query('focus', { tabId: 'tab1', sessionId: 's2' }, SESSION)
  assert.equal(data.switched, true)
  assert.equal(typeof data.switchMs, 'number')
  assert.ok(data.switchMs >= 0)
})

test('client: switch and restore move the app view between Sessions', async () => {
  const { sidebarRight, state } = makeSidebar({ onScreen: 's2', inventory: [{ sessionId: 's1', tabId: 'tab1', kind: 'browser', contentId: 'a' }] })
  const opened = []
  const uiWorkspace = { openSession: (sessionId) => { opened.push(sessionId); state.onScreen = sessionId } }
  const { provider } = makeProvider({ sidebarRight, uiWorkspace })
  const switched = await provider.query('switch', { sessionId: 's1' }, SESSION)
  assert.equal(switched.switched, true)
  assert.equal(switched.previousSessionId, 's2')
  assert.equal(switched.onScreen, true)
  const restored = await provider.query('restore', { sessionId: 's2' }, SESSION)
  assert.equal(restored.restored, true)
  assert.equal(state.onScreen, 's2')
  assert.deepEqual(json(opened), ['s1', 's2'])
})

test('client: restore is skipped when the user navigated away during a temporary switch', async () => {
  const { sidebarRight, state } = makeSidebar({ onScreen: 's1' })
  const opened = []
  const uiWorkspace = { openSession: (sessionId) => { opened.push(sessionId); state.onScreen = sessionId } }
  const { provider } = makeProvider({ sidebarRight, uiWorkspace })
  // The caller switched to s1 earlier, but the user has since opened s2.
  state.onScreen = 's2'
  const restored = await provider.query('restore', { sessionId: 's1', fromSessionId: 's1' }, SESSION)
  assert.equal(restored.restored, false, 'a view the user moved away from must not be restored')
  assert.deepEqual(json(opened), [])
})

test('client: expand of an off-screen Session reports the tab metadata without switching', async () => {
  const { sidebarRight } = makeSidebar({ onScreen: 's2', inventory: [{ sessionId: 's1', tabId: 'tab1', kind: 'browser', contentId: 'a' }] })
  const { provider } = makeProvider({ sidebarRight })
  const data = await provider.query('expand', { tabId: 'tab1' }, SESSION)
  assert.equal(data.tabId, 'tab1')
  assert.equal(data.onScreen, false)
})

test('client: open on an off-screen Session with a live store writes through it without switching', async () => {
  const { sidebarRight, state, calls } = makeSidebar({
    onScreen: 's1',
    adopted: ['s2'],
    inventory: [{ sessionId: 's2', tabId: 'tab1', kind: 'guide', contentId: 'sidebar://guide' }],
    onOpenTabIn: (sessionId, kind, openOptions, inventory) => [...inventory, { sessionId, tabId: 'tab9', kind, contentId: `sidebar://${kind}` }],
  })
  const opened = []
  const uiWorkspace = { openSession: (sessionId) => { opened.push(sessionId); state.onScreen = sessionId } }
  const { provider } = makeProvider({ sidebarRight, uiWorkspace })
  const data = await provider.query('open', { kind: 'guide', sessionId: 's2' }, SESSION)
  assert.equal(data.seamless, true)
  assert.equal(data.switched, false)
  assert.equal(data.tabId, 'tab9')
  assert.deepEqual(json(opened), [])
  assert.equal(state.onScreen, 's1')
  assert.equal(calls.openTabIn[0].sessionId, 's2')
  assert.equal(calls.openTabIn[0].kind, 'guide')
})

test('client: focus and close on a live-store Session do not switch the view', async () => {
  const { sidebarRight, state, calls } = makeSidebar({
    onScreen: 's1',
    adopted: ['s2'],
    inventory: [{ sessionId: 's2', tabId: 'tab1', kind: 'guide', contentId: 'sidebar://guide' }],
  })
  const opened = []
  const uiWorkspace = { openSession: (sessionId) => { opened.push(sessionId); state.onScreen = sessionId } }
  const { provider } = makeProvider({ sidebarRight, uiWorkspace })
  const focused = await provider.query('focus', { tabId: 'tab1', sessionId: 's2' }, SESSION)
  assert.equal(focused.seamless, true)
  assert.deepEqual(json(calls.focusTab), [{ sessionId: 's2', tabId: 'tab1' }])
  const closed = await provider.query('close', { tabId: 'tab1', sessionId: 's2' }, SESSION)
  assert.equal(closed.seamless, true)
  assert.deepEqual(json(calls.closeIn), [{ sessionId: 's2', tabId: 'tab1' }])
  assert.deepEqual(json(opened), [])
  assert.equal(state.inventory.length, 0)
})

test('client: status marks a Session whose sidebar store is live', async () => {
  const { sidebarRight } = makeSidebar({ onScreen: 's1', adopted: ['s2'], inventory: [{ sessionId: 's2', tabId: 'tab1', kind: 'guide', contentId: 'sidebar://guide' }] })
  const { provider } = makeProvider({ sidebarRight })
  const data = await provider.query('status', { sessionId: 's2' }, SESSION)
  assert.equal(data.sessions[0].adopted, true)
  assert.equal(data.onScreen, false)
})

test('client: open reports pending when the inventory never grows', async () => {
  const { sidebarRight } = makeSidebar()
  const { provider } = makeProvider({ sidebarRight })
  const data = await provider.query('open', { kind: 'guide' }, SESSION)
  assert.equal(data.tabId, undefined)
  assert.equal(data.pending, true)
  assert.match(data.note, /not appeared/u)
})

test('client: focus and close validate the tab against this Session', async () => {
  const { sidebarRight, calls } = makeSidebar({ inventory: [{ sessionId: 's1', tabId: 'tab1', kind: 'browser', contentId: 'a' }] })
  const { provider } = makeProvider({ sidebarRight })
  await provider.query('focus', { tabId: 'tab1' }, SESSION)
  await provider.query('close', { tabId: 'tab1' }, SESSION)
  assert.deepEqual(calls.focus, ['tab1'])
  assert.deepEqual(calls.close, ['tab1'])
  await assert.rejects(() => provider.query('focus', { tabId: 'tab404' }, SESSION), /no tab "tab404"/u)
  await assert.rejects(() => provider.query('close', { tabId: 'tab404' }, SESSION), /no tab "tab404"/u)
})

test('client: expand returns the tab row plus the decoded file path', async () => {
  const { sidebarRight } = makeSidebar({
    inventory: [{ sessionId: 's1', tabId: 'tabFile', kind: 'file', contentId: 'dsh-resource://file/session/s1/C:/dir/notes.md' }],
    committed: [{ id: 'tabFile', kind: 'file', title: 'notes.md', contentId: 'dsh-resource://file/session/s1/C:/dir/notes.md' }],
  })
  const { provider } = makeProvider({ sidebarRight })
  const data = await provider.query('expand', { tabId: 'tabFile' }, SESSION)
  assert.equal(data.tabId, 'tabFile')
  assert.equal(data.kind, 'file')
  assert.equal(data.path, 'C:/dir/notes.md')
  await assert.rejects(() => provider.query('expand', { tabId: 'tab404' }, SESSION), /no tab "tab404"/u)
})

test('client: a query without a Session is refused with a clear reason', async () => {
  const { sidebarRight } = makeSidebar()
  const { provider } = makeProvider({ sidebarRight })
  await assert.rejects(() => provider.query('status', {}, {}), /Session-backed Agent/u)
})

test('client: unknown provider methods are refused', async () => {
  const { sidebarRight } = makeSidebar()
  const { provider } = makeProvider({ sidebarRight })
  await assert.rejects(() => provider.query('dance', {}, SESSION), /no method "dance"/u)
})

test('client: pure address helpers keep drive letters and encode segments', () => {
  const { plugin } = loadClient()
  const helpers = plugin.__test
  assert.equal(helpers.sessionFileAddress('s1', 'C:\\dir\\a b.md'), 'dsh-resource://file/session/s1/C:/dir/a%20b.md')
  assert.deepEqual(json(helpers.parseFileAddress('dsh-resource://file/session/s1/C:/dir/a%20b.md')), { scope: 'session', sessionId: 's1', path: 'C:/dir/a b.md' })
  assert.equal(helpers.encodeSegment('C:'), 'C:')
  assert.equal(helpers.isDrawn(null), false)
})










