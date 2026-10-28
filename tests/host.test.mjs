import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, __test, name, inject } from '../index.js'

/** A minimal Host context: tool registry, inspect registry, optional prompt service. */
function makeHarness(options = {}) {
  const tools = []
  let sections = []
  const registry =
    options.registry ?? {
      query: async () => {
        throw new Error('no client')
      },
    }
  const systemPrompt =
    options.systemPrompt === false
      ? undefined
      : {
          section(configuration) {
            sections.push(configuration)
            return () => {}
          },
          getSectionOrder(key) {
            return key === 'TOOLS' ? 100 : 500
          },
        }
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    get(key) {
      if (key === 'cordisInspect') return registry
      if (key === 'systemPrompt') return systemPrompt
      if (key === 'webServer') return options.webServer
      return undefined
    },
    effect(execute) {
      const dispose = execute()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
  apply(ctx, options.config)
  return { tools, tool: tools[0], sections, ctx }
}

const TREE = {
  requestedSessionId: 'session-abcdef012345',
  onScreen: true,
  sessions: [
    {
      sessionId: 'session-abcdef012345',
      onScreen: true,
      expanded: true,
      activeTabId: 'tab1',
      tabs: [
        {
          tabId: 'tab1',
          kind: 'browser',
          title: 'Example Domain',
          url: 'https://example.com/',
          contentId: 'dsh-resource://page/browser/x',
          active: true,
          mounted: true,
          drawn: true,
          hasGuest: true,
        },
        { tabId: 'tab2', kind: 'terminal', title: 'pwsh', contentId: 'dsh-resource://page/terminal/y', active: false, mounted: true, drawn: true, hasGuest: false },
      ],
    },
  ],
}

test('host: apply registers one synchronous tool and returns undefined', () => {
  const { tool } = makeHarness()
  assert.ok(tool, 'the sidebar tool must be registered')
  assert.equal(tool.name, 'sidebar')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.deepEqual(tool.parameters.properties.action.enum, __test.ACTIONS)
  assert.deepEqual(tool.parameters.properties.kind.enum, __test.OPEN_KINDS)
  assert.match(tool.description, /hierarchical|tree/iu)
  assert.match(tool.description, /browser_/u)
  assert.equal(name, 'dsh-sidebar-control')
  assert.deepEqual(inject, ['tools', 'cordisInspect'])
})

test('host: status renders a session tree and caches it for the prompt section', async () => {
  const registry = {
    calls: [],
    async query(platform, provider, method, input) {
      this.calls.push({ platform, provider, method, input })
      return TREE
    },
  }
  const { tool, sections } = makeHarness({ registry })
  const result = await tool.execute({ action: 'status' }, { agent: {}, signal: undefined })
  assert.match(result.text, /sidebar status: 1 session\(s\), 2 tab\(s\)/u)
  assert.match(result.text, /session session-…/u)
  assert.match(result.text, /tab1\tbrowser "Example Domain"\thttps:\/\/example\.com\/\t\[active,mounted,guest\]/u)
  assert.match(result.text, /tab2\tterminal "pwsh"/u)
  assert.equal(registry.calls[0].platform, 'client')
  assert.equal(registry.calls[0].provider, 'SidebarControl')
  assert.equal(registry.calls[0].method, 'status')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tools:sidebar-control')
  assert.equal(sections[0].order, 100)
  const text = sections[0].text()
  assert.match(text, /Last seen sidebar/u)
  assert.match(text, /tab1 browser "Example Domain" \[active\]/u)
})

test('host: status reports Sessions without tabs and non-on-screen warnings', async () => {
  const registry = {
    async query() {
      return { requestedSessionId: 's1', onScreen: false, sessions: [{ sessionId: 's1', onScreen: false, expanded: false, tabs: [] }] }
    },
  }
  const { tool } = makeHarness({ registry })
  const result = await tool.execute({ action: 'status' }, { agent: {}, signal: undefined })
  assert.match(result.text, /\(no open tabs\)/u)
  assert.match(result.text, /sidebar open \{kind:"browser",url\}/u)
  assert.match(result.text, /not the one on screen/u)
})

test('host: open browser mirrors the shell isolation policy before calling the client', async () => {
  const registry = {
    calls: [],
    async query(...args) {
      this.calls.push(args)
      return { kind: 'browser', sessionId: 's1', address: 'https://example.com/', tabId: 'tab9' }
    },
  }
  const { tool } = makeHarness({ registry, webServer: { getOrigin: () => 'http://127.0.0.1:55544' } })
  for (const url of ['http://127.0.0.1:55544/', 'http://localhost:55544/x', 'http://[::1]:55544/']) {
    const refused = await tool.execute({ action: 'open', kind: 'browser', url }, { agent: {}, signal: undefined })
    assert.match(refused.text, /isolation policy/u, `expected a policy refusal for ${url}`)
    assert.match(refused.text, /127\.0\.0\.1:55544/u)
  }
  assert.equal(registry.calls.length, 0, 'a refused open must not reach the client')
  const allowed = await tool.execute({ action: 'open', kind: 'browser', url: 'http://127.0.0.1:47834/' }, { agent: {}, signal: undefined })
  assert.match(allowed.text, /sidebar open \(browser\): tab tab9/u)
  assert.match(allowed.text, /browser_read \{tabId:"tab9"\}/u)
  assert.equal(registry.calls.length, 1)
  assert.equal(registry.calls[0][3].url, 'http://127.0.0.1:47834/')
})

test('host: open browser rejects embedded credentials and non-http schemes', async () => {
  const { tool } = makeHarness()
  await assert.rejects(() => tool.execute({ action: 'open', kind: 'browser', url: 'http://user:pass@example.com/' }, { agent: {} }), /credentials/u)
  await assert.rejects(() => tool.execute({ action: 'open', kind: 'browser', url: 'file:///C:/x.html' }, { agent: {} }), /http/u)
  await assert.rejects(() => tool.execute({ action: 'open', kind: 'nope' }, { agent: {} }), /kind for open/u)
})

test('host: open file passes an absolute path (relative resolved against the Host cwd) and the line', async () => {
  const calls = []
  const registry = {
    async query(_platform, _provider, method, input) {
      calls.push({ method, input })
      return { kind: input.kind, sessionId: 's1', address: 'dsh-resource://file/session/s1/x', tabId: 'tab4', pending: false }
    },
  }
  const { tool } = makeHarness({ registry })
  const result = await tool.execute({ action: 'open', kind: 'file', path: 'README.md', line: 12 }, { agent: {}, signal: undefined })
  assert.match(result.text, /sidebar open \(file\): tab tab4/u)
  assert.equal(calls[0].method, 'open')
  assert.equal(calls[0].input.kind, 'file')
  assert.equal(calls[0].input.line, 12)
  assert.ok(calls[0].input.path.endsWith('README.md'))
  assert.ok(calls[0].input.path.startsWith(process.cwd()) || calls[0].input.path.length > 2)
})

test('host: focus and close forward the tab id', async () => {
  const calls = []
  const registry = {
    async query(_platform, _provider, method, input) {
      calls.push({ method, input })
      return { onScreen: true, focused: true, closed: true }
    },
  }
  const { tool } = makeHarness({ registry })
  const focused = await tool.execute({ action: 'focus', tabId: 'tab1' }, { agent: {} })
  const closed = await tool.execute({ action: 'close', tabId: 'tab1' }, { agent: {} })
  assert.match(focused.text, /sidebar focus: tab1/u)
  assert.match(closed.text, /sidebar close: tab1 closed/u)
  assert.deepEqual(calls.map((entry) => entry.method), ['focus', 'close'])
  await assert.rejects(() => tool.execute({ action: 'focus' }, { agent: {} }), /tabId is required/u)
})

test('host: expand a browser tab pulls text through the adopted browser provider', async () => {
  const registry = {
    calls: [],
    async query(_platform, provider, method) {
      this.calls.push({ provider, method })
      if (provider === 'SidebarControl') {
        return { tabId: 'tab1', kind: 'browser', title: 'Example', url: 'https://example.com/', active: true, mounted: true, drawn: true }
      }
      if (provider === 'AgentBrowser') return { tabId: 'tab1', url: 'https://example.com/', title: 'Example', text: 'Example Domain body text' }
      throw new Error(`unexpected provider ${provider}`)
    },
  }
  const { tool } = makeHarness({ registry })
  const result = await tool.execute({ action: 'expand', tabId: 'tab1' }, { agent: {} })
  assert.match(result.text, /sidebar expand: tab1 \(browser\) \[active,mounted\]/u)
  assert.match(result.text, /Example Domain body text/u)
  assert.match(result.text, /browser_read \{tabId:"tab1", mode:"elements"\}/u)
  assert.deepEqual(registry.calls.map((entry) => `${entry.provider}.${entry.method}`), ['SidebarControl.expand', 'AgentBrowser.read'])
})

test('host: expand a browser tab degrades when the browser provider is unavailable', async () => {
  const registry = {
    async query(_platform, provider) {
      if (provider === 'SidebarControl') return { tabId: 'tab1', kind: 'browser', title: 'Example', url: 'https://example.com/' }
      throw new Error('the in-app browser is not reachable from this Session')
    },
  }
  const { tool } = makeHarness({ registry })
  const result = await tool.execute({ action: 'expand', tabId: 'tab1' }, { agent: {} })
  assert.match(result.text, /could not read this tab/u)
  assert.match(result.text, /browser_read \{tabId:"tab1"/u)
})

test('host: expand a file tab returns a bounded excerpt and the real path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sidebar-control-test-'))
  const file = join(directory, 'notes.md')
  writeFileSync(file, '# Notes\nhello sidebar\n')
  const registry = {
    async query(_platform, provider) {
      if (provider === 'SidebarControl') return { tabId: 'tab5', kind: 'file', path: file, contentId: 'dsh-resource://file/session/s1/notes.md' }
      throw new Error('unexpected provider')
    },
  }
  const { tool } = makeHarness({ registry })
  const result = await tool.execute({ action: 'expand', tabId: 'tab5' }, { agent: {} })
  assert.match(result.text, /path: .*notes\.md/u)
  assert.match(result.text, /hello sidebar/u)
  assert.match(result.text, /use the read tool/u)
})

test('host: pure helpers mirror the shell policy and the file address grammar', () => {
  const host = 'http://127.0.0.1:55544'
  const blocked = [
    'http://127.0.0.1:55544/',
    'http://localhost:55544/manifest.webmanifest',
    'http://[::1]:55544/',
    'https://127.0.0.1:55544/assets/x.js',
  ]
  for (const text of blocked) {
    assert.ok(__test.applicationHostBlock(new URL(text), host), `expected blocked: ${text}`)
  }
  for (const text of ['http://127.0.0.1:47834/', 'http://example.com:55544/', 'https://example.com/']) {
    assert.equal(__test.applicationHostBlock(new URL(text), host), undefined, `expected allowed: ${text}`)
  }
  assert.equal(__test.applicationHostBlock(new URL('http://127.0.0.1:55544/'), undefined), undefined)
  assert.deepEqual(__test.parseFileAddress('dsh-resource://file/session/s1/C:/dir/notes.md'), { scope: 'session', sessionId: 's1', path: 'C:/dir/notes.md' })
  assert.deepEqual(__test.parseFileAddress('dsh-resource://file/absolute/C:/dir/a.md'), { scope: 'absolute', path: 'C:/dir/a.md' })
  assert.equal(__test.parseFileAddress('https://example.com/'), undefined)
})

test('host: prompt overview truncates the tab list', () => {
  const tabs = Array.from({ length: 20 }, (_, index) => ({ tabId: `tab${index}`, kind: 'browser', title: `T${index}` }))
  const text = __test.promptText({ sessions: [{ sessionId: 's1', onScreen: true, tabs }] }, { ...__test.DEFAULTS, maxPromptTabs: 3 })
  assert.match(text, /tab0/u)
  assert.match(text, /tab2/u)
  assert.doesNotMatch(text, /tab3/u)
})

test('host: status truncates the tree at maxTreeTabs', () => {
  const tabs = Array.from({ length: 10 }, (_, index) => ({ tabId: `tab${index}`, kind: 'browser', title: `T${index}` }))
  const text = __test.formatStatus({ requestedSessionId: 's1', onScreen: true, sessions: [{ sessionId: 's1', onScreen: true, tabs }] }, { ...__test.DEFAULTS, maxTreeTabs: 4 })
  assert.match(text, /more tab\(s\) not shown/u)
  assert.equal((text.match(/  tab\d/g) ?? []).length, 4)
})

test('host: a missing system-prompt service is a silent downgrade', () => {
  assert.doesNotThrow(() => makeHarness({ systemPrompt: false }))
})

test('host: tool refuses without an Agent-backed Session', async () => {
  const { tool } = makeHarness()
  await assert.rejects(() => tool.execute({ action: 'status' }, {}), /Agent-backed Session/u)
})
