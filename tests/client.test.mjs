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
  const calls = { openTab: [], openResource: [], focus: [], close: [] }
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
  assert.deepEqual(json(manifest.methods.map((method) => method.name)), ['status', 'open', 'focus', 'close', 'expand'])
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

test('client: commands for a Session whose Sidebar is not on screen are refused', async () => {
  const { sidebarRight } = makeSidebar({ onScreen: 's2', inventory: [{ sessionId: 's1', tabId: 'tab1', kind: 'browser', contentId: 'a' }] })
  const { provider } = makeProvider({ sidebarRight })
  await assert.rejects(() => provider.query('open', { kind: 'guide' }, SESSION), /Sidebar is not on screen/u)
  await assert.rejects(() => provider.query('focus', { tabId: 'tab1' }, SESSION), /Sidebar is not on screen/u)
  await assert.rejects(() => provider.query('close', { tabId: 'tab1' }, SESSION), /Sidebar is not on screen/u)
  const status = await provider.query('status', {}, SESSION)
  assert.equal(status.onScreen, false)
  assert.equal(status.sessions[0].onScreen, false)
  assert.equal(status.sessions[0].expanded, undefined, 'expanded comes from the on-screen Session and must not be attributed to another Session')
  assert.equal(status.sessions[0].activeTabId, undefined, 'activeTabId comes from the on-screen Session and must not be attributed to another Session')
})

test('client: expand refuses an off-screen Session as well', async () => {
  const { sidebarRight } = makeSidebar({ onScreen: 's2', inventory: [{ sessionId: 's1', tabId: 'tab1', kind: 'browser', contentId: 'a' }] })
  const { provider } = makeProvider({ sidebarRight })
  await assert.rejects(() => provider.query('expand', { tabId: 'tab1' }, SESSION), /Sidebar is not on screen/u)
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



