/**
 * dsh-sidebar-control — Host half.
 *
 * Registers one model-facing tool, `sidebar`, and a compact system-prompt
 * section; both are a thin, kind-agnostic control plane over the right Sidebar:
 *
 *   status  → a hierarchical tree of open tabs (browser / terminal / file / …)
 *   open    → open a browser URL, a file preview, a terminal, or the guide
 *   focus   → reveal one tab
 *   close   → close one tab
 *   expand  → pull that tab's content and name the exact tools that act on it
 *
 * Everything about the Sidebar lives in the renderer, so this half asks the
 * Client half through the Cordis Inspect channel (`client` provider
 * `SidebarControl`); it never touches the DOM itself. Browser page actions stay
 * with the `browser_*` tools of `dsh-agent-browser` — this plane opens, names and
 * hands over, it does not reimplement reading or clicking.
 *
 * Platform facts this half is built around:
 * - the Sidebar is per Session and only the Session on screen has an adopted
 *   store; a command for another Session reports that instead of guessing;
 * - the desktop shell isolates the Agent Browser from the DSH Host itself, so
 *   `open {kind:"browser"}` refuses the Host's own origin with an explicit policy
 *   error before the browser tool could surface a bare `ERR_FAILED (-2)`;
 * - a resource tab is opened by address: `dsh-resource://file/session/<sid>/<path>`.
 */
import { isAbsolute, resolve } from 'node:path'
import { readFileSync, statSync } from 'node:fs'

export const name = 'dsh-sidebar-control'

/** The tool registry and the Client inspect registry are required. */
export const inject = ['tools', 'cordisInspect']

/** Client provider id registered by the Client half. */
const PROVIDER = 'SidebarControl'
/** Browser provider id owned by the adopted `dsh-agent-browser` plugin. */
const BROWSER_PROVIDER = 'AgentBrowser'
/** Hostnames the desktop shell treats as the DSH Host itself. */
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]']
/** File-resource scheme the document-preview tab type claims. */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'
/** Actions this tool exposes. */
const ACTIONS = ['status', 'open', 'focus', 'close', 'expand']
/** Kinds `open` accepts. */
const OPEN_KINDS = ['browser', 'file', 'terminal', 'guide']

const DEFAULTS = {
  /** Tabs rendered in the prompt overview (a bigger tree stays tool-only). */
  maxPromptTabs: 8,
  /** Tabs rendered by `status`. */
  maxTreeTabs: 40,
  /** Content characters `expand` returns by default. */
  maxExpandChars: 4000,
  /** Files larger than this are not read into an expand receipt. */
  maxFileBytes: 512 * 1024,
}

const DESCRIPTION =
  'Inspect and control the DSH right Sidebar as one workspace. ' +
  'action=status returns the open tabs of the requesting Session (or every Session with includeAllSessions) as a compact tree: tabId, kind (browser/terminal/file/guide), title, url or path, active, mounted. ' +
  'action=open opens a tab: {kind:"browser",url} (the user-visible in-app browser; the same tab the browser_* tools drive; pass an existing browser tabId to navigate that tab instead of opening another), {kind:"file",path,line?} (document preview; a relative path resolves against the Session working directory), {kind:"terminal",shellPath?} (a visible terminal), or {kind:"guide"}. ' +
  'action=focus and action=close take a tabId. ' +
  'action=expand returns one tab\'s content and the exact tools for it: a browser tab yields text (mode:text, default), interactive elements with refs (mode:elements) or page HTML (mode:html) plus the browser_* hand-off; a file tab yields a bounded text excerpt and the real path; a terminal tab names the terminal_* tools that read or drive it. ' +
  'Workflow: call status before acting on a tab you did not open, open what the user needs to see, expand only when you actually need the content, and drive browser pages with the browser_* tools (this tool is the overview/navigation plane, not a second browser implementation). ' +
  'Another Session can be targeted with sessionId; status reads it directly, while open/focus/close/expand briefly show that Session in the main view (the switch is visible to the user) and then restore the previously shown Session. ' +
  'Boundaries: the Sidebar is per Session; commands act on the Session whose Sidebar is on screen and report when that surface is unavailable. ' +
  'The desktop shell isolates the in-app browser from the DSH Host origin: open {kind:"browser"} refuses any loopback hostname on the DSH Host port with an explicit policy error (file:// is likewise unavailable). ' +
  'A visible terminal tab is created by the Sidebar terminal plugin and is not necessarily the same terminal process as a terminal_* tool session; v0.1 reports that instead of pretending to bridge them. ' +
  'Unknown tab kinds are inventory-only: they can be listed, focused and closed, but not read.'

/** Reject anything that is not a plain http(s) URL, returning a URL instance. */
function requireHttpUrl(raw, field) {
  const text = String(raw ?? '').trim()
  if (text === '') throw new Error(`sidebar: ${field} is required`)
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error(`sidebar: ${field} is not a valid URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`sidebar: ${field} must use http:// or https://, got ${url.protocol}//`)
  }
  return url
}

/** Mirror of the desktop shell's guest isolation predicate (DesktopBrowserGuests). */
function applicationHostBlock(url, hostOrigin) {
  if (typeof hostOrigin !== 'string' || hostOrigin === '') return undefined
  let host
  try {
    host = new URL(hostOrigin)
  } catch {
    return undefined
  }
  if (url.port !== host.port) return undefined
  if (url.hostname !== host.hostname && !LOOPBACK_HOSTNAMES.includes(url.hostname)) return undefined
  return { origin: host.origin, target: url.href }
}

/** The live DSH Host origin, when the webserver service can report it. */
function hostOriginOf(ctx) {
  try {
    const webserver = ctx.get('webServer')
    const origin = webserver?.getOrigin?.()
    return typeof origin === 'string' && origin !== '' ? origin : undefined
  } catch {
    return undefined
  }
}

/** Decode a `dsh-resource://file/...` address into its scope and path. */
function parseFileAddress(address) {
  if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
  try {
    const end = address.search(/[?#]/u)
    const [scope, ...rest] = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end).split('/')
    if (scope === 'session') {
      const [id, ...segments] = rest
      if (id === undefined || id === '' || segments.length === 0) return undefined
      return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
    }
    if (scope === 'absolute') {
      const unc = rest[0] === '' && rest.length > 1
      const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent)
      if (segments.length === 0 || segments[0] === '') return undefined
      return { scope, path: unc ? `//${segments.join('/')}` : /^[A-Za-z]:$/u.test(segments[0]) ? segments.join('/') : `/${segments.join('/')}` }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Shorten a Session id for display. */
function shortSession(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : String(sessionId ?? '')
}

/** Clamp a requested character budget. */
function clampChars(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(20000, Math.max(200, Math.round(number)))
}

/** Resolve after `ms` milliseconds. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Receipt line explaining that a command briefly showed another Session so its
 * Sidebar was actionable, and that the previously shown Session came back.
 */
function switchNote(data) {
  if (data?.switched !== true) return undefined
  const target = typeof data.sessionId === 'string' && data.sessionId !== '' ? shortSession(data.sessionId) : 'the target Session'
  const previous = typeof data.previousSessionId === 'string' && data.previousSessionId !== '' ? shortSession(data.previousSessionId) : undefined
  return previous === undefined
    ? `note: the app temporarily showed Session ${target} to perform this (no previous Session to restore).`
    : `note: the app temporarily showed Session ${target} to perform this, then restored Session ${previous}.`
}

/** Render one tab row for the tree text. */
function tabLine(tab) {
  const flags = []
  if (tab.active === true) flags.push('active')
  if (tab.mounted === true) flags.push('mounted')
  else flags.push('unmounted')
  if (tab.mounted === true && tab.drawn === false) flags.push('hidden')
  if (tab.hasGuest === true) flags.push('guest')
  const where = tab.url ?? tab.path ?? tab.contentId ?? ''
  const title = typeof tab.title === 'string' && tab.title !== '' ? ` "${tab.title.slice(0, 80)}"` : ''
  return `  ${String(tab.tabId ?? '?')}\t${String(tab.kind ?? '?')}${title}\t${where}\t[${flags.join(',')}]`
}

/** Render a `status` answer as a compact tree. */
function formatStatus(data, settings) {
  const sessions = Array.isArray(data?.sessions) ? data.sessions : []
  const lines = []
  const totalTabs = sessions.reduce((sum, session) => sum + (Array.isArray(session?.tabs) ? session.tabs.length : 0), 0)
  lines.push(
    `sidebar status: ${sessions.length} session(s), ${totalTabs} tab(s); requesting session ${shortSession(data?.requestedSessionId)} on-screen=${data?.onScreen === true ? 'yes' : 'no'}`,
  )
  let rendered = 0
  for (const session of sessions) {
    const flags = [`on-screen=${session?.onScreen === true ? 'yes' : 'no'}`]
    if (typeof session?.expanded === 'boolean') flags.push(`expanded=${session.expanded ? 'yes' : 'no'}`)
    if (typeof session?.activeTabId === 'string' && session.activeTabId !== '') flags.push(`active=${session.activeTabId}`)
    lines.push(`session ${shortSession(session?.sessionId)} (${flags.join(', ')})`)
    const tabs = Array.isArray(session?.tabs) ? session.tabs : []
    if (tabs.length === 0) {
      lines.push('  (no open tabs)')
      continue
    }
    for (const tab of tabs) {
      if (rendered >= settings.maxTreeTabs) {
        lines.push(`  … ${totalTabs - settings.maxTreeTabs} more tab(s) not shown`)
        rendered = totalTabs
        break
      }
      lines.push(tabLine(tab))
      rendered += 1
    }
  }
  if (sessions.every((session) => (Array.isArray(session?.tabs) ? session.tabs.length : 0) === 0)) {
    lines.push('Open something with sidebar open {kind:"browser",url} | {kind:"file",path} | {kind:"terminal"} | {kind:"guide"}.')
  }
  if (data?.onScreen !== true) {
    const onScreen = typeof data?.onScreenSessionId === 'string' && data.onScreenSessionId !== '' ? shortSession(data.onScreenSessionId) : undefined
    lines.push(
      `note: the requesting Session is not the one on screen${onScreen === undefined ? '' : ` (on-screen session ${onScreen})`}; navigation commands (open/focus/close/expand) briefly show this Session and then restore the on-screen one.`,
    )
  }
  return lines.join('\n')
}

/** Render the tool's `open` receipt. */
function formatOpen(data, kind) {
  const tabId = typeof data?.tabId === 'string' && data.tabId !== '' ? data.tabId : undefined
  const where = kind === 'browser' ? data?.address : kind === 'file' ? data?.path ?? data?.address : data?.shellPath
  const lines = []
  if (tabId === undefined) {
    lines.push(`sidebar open (${kind}): requested${where ? ` ${where}` : ''}, but the tab has not appeared in the inventory yet.`)
    if (typeof data?.note === 'string') lines.push(data.note)
    lines.push('Call sidebar status to confirm what opened.')
    return lines.join('\n')
  }
  lines.push(`sidebar open (${kind}): tab ${tabId}${where ? ` — ${where}` : ''}`)
  const switching = switchNote(data)
  if (switching !== undefined) lines.push(switching)
  if (typeof data?.tabKind === 'string' && data.tabKind !== '' && data.tabKind !== kind) {
    lines.push(`Sidebar tab kind: ${data.tabKind} (the requested "${kind}" kind is claimed by a more specific tab type)`)
  }
  if (kind === 'browser') {
    lines.push(`next: browser_read {tabId:"${tabId}"} to read it; browser_act/browser_screenshot/browser_navigate drive the same tab; sidebar expand {tabId:"${tabId}"} returns the text.`)
  } else if (kind === 'file') {
    lines.push(`next: sidebar expand {tabId:"${tabId}"} for a text excerpt, or read the path directly.`)
  } else if (kind === 'terminal') {
    lines.push('note: the visible terminal is a Sidebar terminal tab; terminal_list/terminal_read act on terminal_* tool sessions (v0.1 does not bridge identities).')
  }
  return lines.join('\n')
}

/** Render the tool's `expand` receipt. */
function formatExpand(data, content, note, mode) {
  const flags = []
  if (data?.active === true) flags.push('active')
  if (data?.mounted === true) flags.push('mounted')
  if (data?.mounted === true && data?.drawn === false) flags.push('hidden')
  const lines = []
  lines.push(`sidebar expand: ${String(data?.tabId ?? '?')} (${String(data?.kind ?? '?')})${flags.length > 0 ? ` [${flags.join(',')}]` : ''}`)
  if (typeof data?.title === 'string' && data.title !== '') lines.push(`title: ${data.title}`)
  if (typeof data?.url === 'string' && data.url !== '') lines.push(`url: ${data.url}`)
  if (typeof data?.path === 'string' && data.path !== '') lines.push(`path: ${data.path}`)
  if (typeof data?.contentId === 'string' && data.contentId !== '') lines.push(`contentId: ${data.contentId}`)
  if (typeof mode === 'string' && mode !== '' && mode !== 'text' && content !== undefined) lines.push(`content mode: ${mode}`)
  if (typeof note === 'string' && note !== '') lines.push(note)
  if (typeof content === 'string' && content !== '') {
    lines.push('content:')
    lines.push(content)
  }
  if (data?.kind === 'browser') {
    lines.push(`next: browser_read {tabId:"${String(data.tabId)}", mode:"elements"} for clickable refs, then browser_act/browser_navigate/browser_screenshot on the same tabId.`)
  } else if (typeof data?.path === 'string' && data.path !== '') {
    lines.push('next: use the read tool on the path above (expand only returns a bounded excerpt).')
  } else if (data?.kind === 'file' || data?.kind === 'text') {
    lines.push('next: use the read tool on the path above when you know it (expand only returns a bounded excerpt).')
  } else if (data?.kind === 'terminal') {
    lines.push('next: terminal_list / terminal_read for terminal_* tool sessions; this tab is a separate visible terminal in v0.1.')
  } else {
    lines.push('next: this tab kind is inventory-only; it can be focused or closed but its content is not readable from here.')
  }
  return lines.join('\n')
}

/**
 * The inspect channel wraps a provider's failure in its own timeout text; the
 * provider's diagnosis is the actionable part, so surface that instead of the
 * wrapper. Returns the original message when it carries no provider failure.
 */
function unwrapInspectError(error) {
  const message = String(error && error.message ? error.message : error)
  const providerFailure = /Client failure:\s*([\s\S]+)$/u.exec(message)
  if (providerFailure === null) return message
  const diagnosis = providerFailure[1].trim().replace(/^provider-error:\s*/iu, '')
  return diagnosis
}

/**
 * Read a bounded UTF-8 text excerpt from a file. Returns `{ text }` on success,
 * or `{ error }` when the file is missing, too large or not text.
 */
function readTextExcerpt(path, maxChars, maxBytes) {
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return { error: 'not a regular file' }
    if (stats.size > maxBytes) return { error: `file is ${stats.size} bytes; larger than the ${maxBytes}-byte excerpt cap` }
    const buffer = readFileSync(path)
    if (buffer.subarray(0, 4096).includes(0)) return { error: 'binary file (no text excerpt)' }
    const text = buffer.toString('utf8')
    return { text: text.length > maxChars ? `${text.slice(0, maxChars)}\n… (${text.length - maxChars} more chars)` : text }
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) }
  }
}

/** The prompt section: a compact, stable instruction block plus the last tree. */
function promptText(lastTree, settings) {
  const lines = [
    '## Sidebar control plane (dsh-sidebar-control)',
    'The right Sidebar is one workspace of tabs (browser, terminal, file preview, guide). Use `sidebar` instead of guessing its state.',
    '- `sidebar status` → compact tree: tabId, kind, title, url/path, active/mounted. Call it before acting on tabs you did not open.',
    '- `sidebar open {kind:"browser",url}` opens the user-visible in-app browser (pass an existing browser `tabId` to navigate it in place); the DSH Host origin is refused with an explicit policy error. `{kind:"file",path,line?}` (relative paths resolve against the Session directory), `{kind:"terminal",shellPath?}`, `{kind:"guide"}` open the other kinds.',
    '- `sidebar focus {tabId}` / `sidebar close {tabId}`.',
    '- `sidebar expand {tabId, mode?}` only when the content is actually needed: browser tab → text (default) / elements with refs / html + the browser_* hand-off; file tab → bounded excerpt + real path; terminal tab → which terminal_* tools apply.',
    '- Pass `sessionId` to work on another Session: status reads it; open/focus/close/expand briefly show that Session and then restore the one that was on screen (the switch is visible to the user, so prefer doing this when they are not mid-task).',
    'Drive browser pages with the browser_* tools (browser_read → browser_act / browser_screenshot / browser_navigate); this tool is the overview/navigation plane.',
  ]
  const sessions = Array.isArray(lastTree?.sessions) ? lastTree.sessions : []
  if (sessions.length > 0) {
    lines.push('Last seen sidebar (call `sidebar status` to refresh):')
    let rendered = 0
    for (const session of sessions) {
      const tabs = Array.isArray(session?.tabs) ? session.tabs : []
      if (tabs.length === 0) continue
      lines.push(`- session ${shortSession(session.sessionId)}${session.onScreen === true ? ' (on screen)' : ''}:`)
      for (const tab of tabs) {
        if (rendered >= settings.maxPromptTabs) {
          lines.push('  - …')
          rendered = settings.maxPromptTabs + 1
          break
        }
        const title = typeof tab.title === 'string' && tab.title !== '' ? ` "${tab.title.slice(0, 40)}"` : ''
        const where = tab.kind === 'browser' && typeof tab.url === 'string' && tab.url !== '' ? ` <${tab.url.slice(0, 60)}>` : ''
        lines.push(`  - ${tab.tabId} ${tab.kind}${title}${where}${tab.active === true ? ' [active]' : ''}`)
        rendered += 1
      }
      if (rendered > settings.maxPromptTabs) break
    }
  }
  return lines.join('\n')
}

/**
 * Mount the tool and the prompt section.
 * @param ctx - Host context carrying `tools` and `cordisInspect`.
 * @param config - optional profile config (see DEFAULTS).
 */
export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }
  /** Last `status`/`open` answer, used only to render the prompt overview. */
  let lastTree

  /** Query the Client half through the Cordis Inspect channel. */
  async function callClient(method, input, agent, signal) {
    const registry = ctx.get('cordisInspect')
    if (registry === undefined) {
      throw new Error('sidebar: the Cordis inspect registry is not mounted in this composition, so the Sidebar cannot be reached')
    }
    try {
      return await registry.query('client', PROVIDER, method, input, agent, signal)
    } catch (error) {
      throw new Error(unwrapInspectError(error))
    }
  }

  /** Query the adopted browser plugin's Client provider, when it is installed. */
  async function callBrowserProvider(method, input, agent, signal) {
    const registry = ctx.get('cordisInspect')
    if (registry === undefined) throw new Error('sidebar: the Cordis inspect registry is not mounted')
    try {
      return await registry.query('client', BROWSER_PROVIDER, method, input, agent, signal)
    } catch (error) {
      throw new Error(unwrapInspectError(error))
    }
  }

  /** Live Agent of another Session, when it exists (used to resolve its workspace). */
  function agentFor(ctx, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    try {
      const agents = ctx.get('agents')
      return typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Effective working directory of a Session, used to resolve a relative file
   * path against the workspace the agent is actually in (the Host process cwd is
   * a deployment detail, not the Session's directory). An explicit target
   * Session passes its own Agent so its workspace wins.
   */
  async function sessionWorkingDirectory(agent, signal) {
    try {
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory !== undefined && typeof workingDirectory.ensure === 'function') {
        return await workingDirectory.ensure(agent, signal)
      }
    } catch {
      // Fall back to the Host cwd.
    }
    return process.cwd()
  }

  /** Refresh the prompt overview from the last answered tree. */
  function rememberTree(value) {
    if (value !== undefined && value !== null && Array.isArray(value.sessions)) lastTree = value
  }

  /** `sessionId` from the tool args, or undefined for the requesting Session. */
  function optionalSessionId(args) {
    return typeof args.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : undefined
  }

  async function executeStatus(args, agent, signal) {
    const sessionId = optionalSessionId(args)
    const data = await callClient(
      'status',
      { ...(sessionId === undefined ? {} : { sessionId }), includeAllSessions: args.includeAllSessions === true },
      agent,
      signal,
    )
    rememberTree(data)
    return { text: formatStatus(data, settings) }
  }

  async function executeOpen(args, agent, signal) {
    const sessionId = optionalSessionId(args)
    const kind = String(args.kind ?? '')
    if (!OPEN_KINDS.includes(kind)) throw new Error(`sidebar: kind for open must be one of ${OPEN_KINDS.join(', ')}, got "${kind}"`)
    let input
    if (kind === 'browser') {
      const url = requireHttpUrl(args.url, 'url')
      if (url.username !== '' || url.password !== '') {
        throw new Error('sidebar: URLs with embedded credentials are blocked by the desktop shell; remove the user:pass@ part')
      }
      const blocked = applicationHostBlock(url, hostOriginOf(ctx))
      if (blocked !== undefined) {
        return {
          text:
            `sidebar open refused by the desktop shell's isolation policy: the in-app browser cannot load the DSH Host itself (${blocked.origin}). ` +
            `Requests to the Host's own port are cancelled (Chromium reports a bare ERR_FAILED -2). Use a file tab, a data URL through the browser plugin's own tools, ` +
            `or a separate standalone 'dsh web' instance to inspect the GUI. (target: ${blocked.target})`,
        }
      }
      input = { kind, url: url.href, ...(sessionId === undefined ? {} : { sessionId }) }
      const targetTab = typeof args.tabId === 'string' && args.tabId !== '' ? args.tabId : undefined
      if (targetTab !== undefined) {
        // Reusing an existing browser tab avoids tab sprawl: navigate it in place.
        // The adopted browser provider resolves tabs within the querying Agent's
        // Session, so a tab of another Session cannot be addressed safely (per-
        // Session tab ids can collide); ask for a new tab instead.
        const agentSessionId = typeof agent?.id === 'string' ? agent.id : undefined
        if (sessionId !== undefined && agentSessionId !== undefined && sessionId !== agentSessionId) {
          return {
            text:
              `sidebar open (browser): cannot navigate tab ${targetTab} in another Session — the browser provider scopes tabs to the requesting Agent's Session (tab ids are per-Session and can collide). ` +
              `Open a new browser tab there with sidebar open {kind:"browser",url:"${url.href}",sessionId:"${sessionId}"} instead.`,
          }
        }
        await callBrowserProvider('navigate', { url: url.href, tabId: targetTab }, agent, signal)
        return {
          text:
            `sidebar open (browser): navigated tab ${targetTab} to ${url.href}\n` +
            `next: browser_read {tabId:"${targetTab}"} to read it; browser_act/browser_screenshot drive the same tab.`,
        }
      }
    } else if (kind === 'file') {
      const raw = String(args.path ?? '').trim()
      if (raw === '') throw new Error('sidebar: path is required for kind "file"')
      const owner = sessionId === undefined ? agent : agentFor(ctx, sessionId) ?? agent
      const base = isAbsolute(raw) ? undefined : await sessionWorkingDirectory(owner, signal)
      const path = base === undefined ? raw : resolve(base, raw)
      input = { kind, path, ...(Number.isFinite(args.line) ? { line: Number(args.line) } : {}), ...(sessionId === undefined ? {} : { sessionId }) }
    } else if (kind === 'terminal') {
      input = { kind, ...(typeof args.shellPath === 'string' && args.shellPath !== '' ? { shellPath: args.shellPath } : {}), ...(sessionId === undefined ? {} : { sessionId }) }
    } else {
      input = { kind, ...(sessionId === undefined ? {} : { sessionId }) }
    }
    const data = await callClient('open', input, agent, signal)
    return { text: formatOpen({ ...data, path: input.path, shellPath: input.shellPath, sessionId: data?.sessionId ?? sessionId }, kind) }
  }

  async function executeFocus(args, agent, signal) {
    const tabId = String(args.tabId ?? '')
    if (tabId === '') throw new Error('sidebar: tabId is required')
    const sessionId = optionalSessionId(args)
    const data = await callClient('focus', { tabId, ...(sessionId === undefined ? {} : { sessionId }) }, agent, signal)
    const note = switchNote({ ...data, sessionId: data?.sessionId ?? sessionId })
    return { text: `sidebar focus: ${tabId} requested${note === undefined ? '' : `\n${note}`}` }
  }

  async function executeClose(args, agent, signal) {
    const tabId = String(args.tabId ?? '')
    if (tabId === '') throw new Error('sidebar: tabId is required')
    const sessionId = optionalSessionId(args)
    const data = await callClient('close', { tabId, ...(sessionId === undefined ? {} : { sessionId }) }, agent, signal)
    const note = switchNote({ ...data, sessionId: data?.sessionId ?? sessionId })
    return { text: `sidebar close: ${tabId} closed${note === undefined ? '' : `\n${note}`}` }
  }

  /** Resolve the browser provider's read answer into the requested content mode. */
  function browserReadContent(read, mode) {
    if (mode === 'html') return read?.html ?? read?.value?.html
    if (mode === 'elements') {
      const elements = read?.elements ?? read?.value?.elements ?? read
      return typeof elements === 'string' ? elements : elements === undefined ? undefined : JSON.stringify(elements, null, 2)
    }
    return read?.text ?? read?.value?.text
  }

  async function executeExpand(args, agent, signal) {
    const tabId = String(args.tabId ?? '')
    if (tabId === '') throw new Error('sidebar: tabId is required')
    const sessionId = optionalSessionId(args)
    const maxChars = clampChars(args.maxChars, settings.maxExpandChars)
    const requestedMode = args.mode === 'elements' || args.mode === 'html' ? String(args.mode) : 'text'
    const data = await callClient('expand', { tabId, ...(sessionId === undefined ? {} : { sessionId }) }, agent, signal)
    let content
    let note
    let switched
    const agentSessionId = typeof agent?.id === 'string' ? agent.id : undefined
    const crossSession = typeof data?.sessionId === 'string' && agentSessionId !== undefined && data.sessionId !== agentSessionId
    if (data?.kind === 'browser') {
      try {
        if (crossSession) {
          // The adopted browser provider scopes every tab to the querying Agent's
          // Session, so another Session's tab cannot be read without reading the
          // wrong tab (tab ids are per-Session). Report that instead of guessing.
          note =
            `browser content of another Session cannot be read through the session-scoped browser provider; only this tab's metadata is returned. ` +
            `Read it from that Session's own conversation, or open the URL in this Session with sidebar open {kind:"browser",url}.`
        } else if (data.onScreen !== true) {
          // Reading a mounted guest needs its Session drawn; show it briefly.
          switched = await callClient('switch', { sessionId: data.sessionId }, agent, signal)
          await delay(250)
        }
        let lastError
        for (let attempt = 0; attempt < (crossSession ? 0 : 3); attempt += 1) {
          try {
            const read = await callBrowserProvider('read', { tabId, mode: requestedMode, maxChars }, agent, signal)
            content = browserReadContent(read, requestedMode)
            lastError = undefined
            break
          } catch (error) {
            lastError = error
            await delay(300)
          }
        }
        if (content === undefined && note === undefined) {
          note =
            lastError === undefined
              ? 'the browser provider answered but returned no content for this mode; the page may be empty or still loading'
              : `the browser provider could not read this tab: ${String(lastError && lastError.message ? lastError.message : lastError)}`
        } else if (typeof content === 'string' && content.length > maxChars) {
          content = `${content.slice(0, maxChars)}\n… (${content.length - maxChars} more chars)`
        }
      } finally {
        if (switched?.switched === true) {
          await callClient('restore', { sessionId: switched.previousSessionId, fromSessionId: data.sessionId }, agent, signal).catch(() => {})
        }
      }
    } else if (typeof data?.path === 'string' && data.path !== '') {
      const base = isAbsolute(data.path) ? undefined : await sessionWorkingDirectory(agent, signal)
      const path = base === undefined ? data.path : resolve(base, data.path)
      const excerpt = readTextExcerpt(path, maxChars, settings.maxFileBytes)
      if (typeof excerpt.text === 'string') content = excerpt.text
      else note = `could not read ${path}: ${excerpt.error}`
    } else if (data?.kind === 'file' || data?.kind === 'text') {
      note = 'this file tab was opened before this Session; its path is not recorded here — read it with the file tools when you know the path'
    }
    const switching = switchNote({ switched: switched?.switched === true, sessionId: data?.sessionId ?? sessionId, previousSessionId: switched?.previousSessionId })
    if (switching !== undefined) note = note === undefined ? switching : `${note}\n${switching}`
    return { text: formatExpand(data, content, note, data?.kind === 'browser' ? requestedMode : undefined) }
  }

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'sidebar',
        description: DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ACTIONS, description: 'What to do with the Sidebar.' },
            kind: { type: 'string', enum: OPEN_KINDS, description: 'Tab kind for action=open: browser, file, terminal or guide.' },
            url: { type: 'string', description: 'HTTP(S) URL for action=open, kind=browser.' },
            path: { type: 'string', description: 'Absolute (or Session-working-directory-relative) file path for action=open, kind=file.' },
            line: { type: 'number', description: 'One-based source line for action=open, kind=file.' },
            shellPath: { type: 'string', description: 'Shell executable for action=open, kind=terminal; the Sidebar default when omitted.' },
            tabId: { type: 'string', description: 'Tab id from action=status: used by focus/close/expand, and by open {kind:"browser"} to navigate that existing browser tab in place.' },
            includeAllSessions: { type: 'boolean', description: 'For action=status: include Sessions other than the requesting one.' },
            sessionId: { type: 'string', description: 'Target Session for status/open/focus/close/expand (defaults to the requesting Session). Navigation commands briefly show that Session in the main view and restore the previously shown one.' },
            maxChars: { type: 'number', description: 'For action=expand: content character budget (default 4000, max 20000).' },
            mode: { type: 'string', enum: ['text', 'elements', 'html'], description: 'For action=expand on a browser tab: what to return (default text; elements carries the refs browser_act accepts; html is the page source).' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args, exec) {
          const action = String(args.action ?? '')
          if (!ACTIONS.includes(action)) throw new Error(`sidebar: unknown action "${action}"`)
          if (exec.agent === undefined) throw new Error('sidebar: this tool requires an Agent-backed Session')
          const agent = exec.agent
          const signal = exec.signal
          switch (action) {
            case 'status':
              return executeStatus(args, agent, signal)
            case 'open':
              return executeOpen(args, agent, signal)
            case 'focus':
              return executeFocus(args, agent, signal)
            case 'close':
              return executeClose(args, agent, signal)
            case 'expand':
              return executeExpand(args, agent, signal)
            default:
              throw new Error(`sidebar: unknown action "${action}"`)
          }
        },
      }),
    'dsh-sidebar-control.tool',
  )

  // The overview is an optional enhancement: without the system-prompt service
  // the tool still works, so a composition without it is not an error.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
    // The system-prompt section registry has no generic "tools" slot; the tool
    // documentation block ends around TOOL_COMPUTER_USE/MCP_SERVERS, so the
    // overview sits just after computer use (unknown keys resolve to undefined).
    const anchor = typeof systemPrompt.getSectionOrder === 'function' ? systemPrompt.getSectionOrder('TOOL_COMPUTER_USE') : undefined
    const order = Number.isFinite(anchor) ? anchor + 50 : 3050
    ctx.effect(
      () =>
        systemPrompt.section({
          name: 'tools:sidebar-control',
          order,
          text: () => promptText(lastTree, settings),
        }),
      'dsh-sidebar-control.prompt',
    )
  }
}

/** Pure helpers exposed for tests (no side effects). */
export const __test = {
  ACTIONS,
  OPEN_KINDS,
  DEFAULTS,
  requireHttpUrl,
  applicationHostBlock,
  parseFileAddress,
  readTextExcerpt,
  formatStatus,
  formatOpen,
  formatExpand,
  promptText,
}







