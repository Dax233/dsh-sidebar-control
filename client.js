/**
 * dsh-sidebar-control — Client half.
 *
 * Registers one Client Cordis Inspect provider (`SidebarControl`) that reads and
 * navigates the right Sidebar. The Sidebar lives in the renderer, so this is the
 * half that touches its store and DOM; the Host half (index.js) turns provider
 * answers into the model-facing `sidebar` tool and the prompt overview.
 *
 * What this half may use (all public traffic between plugins):
 * - `ctx.sidebarRight`: `openTabs` inventory, `tabsIn`, `openTab`, `openResource`,
 *   `close`, `focus`, `active`, `isExpanded`, `mounted` (the on-screen Session).
 * - DOM markers owned by `ui-sidebar-right` / `ui-sidebar-browser`:
 *   `[data-sidebar-right-session]`, `[data-sidebar-right-tab]`,
 *   `<webview data-sidebar-browser-frame="webview">`.
 *
 * Every command acts on the Session on screen (the one whose Sidebar is drawn);
 * `openTab`/`openResource` throw or no-op for a Session whose store was never
 * adopted, and this half reports that instead of pretending it worked.
 */
window.__ModuleLoader__.load({
  id: 'dsh-sidebar-control',
  factory(require) {
    var module = { exports: {} };

    /** Inspect provider id the Host half queries. */
    const PROVIDER = 'SidebarControl';
    /** Address scheme every Sidebar resource page is recorded under. */
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';
    /** Hostnames the desktop shell treats as the DSH Host itself. */
    const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];
    /** Page kinds this plane knows how to open; other kinds are inventory-only. */
    const OPEN_KINDS = ['browser', 'file', 'terminal', 'guide'];

    /** Escape a value for a CSS attribute selector. */
    function escapeCss(value) {
      const text = String(value);
      try {
        if (globalThis.CSS !== undefined && typeof globalThis.CSS.escape === 'function') {
          return globalThis.CSS.escape(text);
        }
      } catch {
        // Fall through to the conservative escape.
      }
      return text.replace(/["\\]/gu, '\\$&');
    }

    /** Encode one address segment, keeping `:` literal for Windows drive letters. */
    function encodeSegment(segment) {
      return encodeURIComponent(String(segment)).replace(/%3A/giu, ':');
    }

    /** Encode a `/`-separated path segment by segment. */
    function encodePath(path) {
      const normalized = String(path).replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '');
      return normalized.split('/').map(encodeSegment).join('/');
    }

    /**
     * Build the `dsh-resource://file/session/<sessionId>/<path>` address the
     * document-preview tab type claims.
     */
    function sessionFileAddress(sessionId, path) {
      return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(path)}`;
    }

    /**
     * Decode a `dsh-resource://file/...` address into its scope and path, so an
     * expanded file tab can name the real path. Returns undefined for addresses
     * this grammar does not describe.
     */
    function parseFileAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
      try {
        const end = address.search(/[?#]/u);
        const body = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end);
        const [scope, ...rest] = body.split('/');
        if (scope === 'session') {
          const [id, ...segments] = rest;
          if (id === undefined || id === '' || segments.length === 0) return undefined;
          return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') };
        }
        if (scope === 'absolute') {
          const unc = rest[0] === '' && rest.length > 1;
          const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent);
          if (segments.length === 0 || segments[0] === '') return undefined;
          return { scope, path: unc ? `//${segments.join('/')}` : /^[A-Za-z]:$/u.test(segments[0]) ? segments.join('/') : `/${segments.join('/')}` };
        }
        return undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * Whether an element is actually drawn. Tab bodies are often wrapped in a
     * `display: contents` marker, whose own box is zero-sized, so the check looks
     * at the element and a bounded set of descendants instead of trusting the
     * wrapper rect; a hidden tab has neither a visible box nor a visible
     * descendant, and Chromium's `checkVisibility` answers directly when present.
     */
    function isDrawn(element) {
      if (element === undefined || element === null) return false;
      try {
        if (typeof element.checkVisibility === 'function') {
          if (element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true }) === true) return true;
        }
      } catch {
        // Fall through to geometry.
      }
      const nodes = [element];
      try {
        nodes.push(...[...element.querySelectorAll('*')].slice(0, 64));
      } catch {
        // A stub DOM in tests may not implement querySelectorAll.
      }
      for (const node of nodes) {
        try {
          const rect = node.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return true;
        } catch {
          // Keep looking.
        }
      }
      return false;
    }

    /** Every tab body wrapper of one Session, keyed by tab id (first wins). */
    function tabWrappers(sessionId) {
      const found = new Map();
      const selector = `[data-sidebar-right-session="${escapeCss(sessionId)}"] [data-sidebar-right-tab]`;
      let wrappers = [];
      try {
        wrappers = [...document.querySelectorAll(selector)];
      } catch {
        wrappers = [];
      }
      for (const wrapper of wrappers) {
        const tabId = wrapper?.dataset?.sidebarRightTab;
        if (typeof tabId !== 'string' || tabId === '') continue;
        // The tab chip and the tab body both carry `data-sidebar-right-tab`;
        // the body is the one that can hold a browser guest, so prefer it.
        const existing = found.get(tabId);
        if (existing === undefined) {
          found.set(tabId, wrapper);
          continue;
        }
        if (browserGuest(existing) === undefined && browserGuest(wrapper) !== undefined) found.set(tabId, wrapper);
      }
      return found;
    }

    /** The browser guest of one tab, when the wrapper holds a webview carrier. */
    function browserGuest(wrapper) {
      if (wrapper === undefined || wrapper === null) return undefined;
      try {
        return wrapper.querySelector('webview[data-sidebar-browser-frame="webview"]') ?? undefined;
      } catch {
        return undefined;
      }
    }

    /** Read a browser guest's URL/title without trusting either to be present. */
    function guestIdentity(guest) {
      const identity = { url: undefined, title: undefined, loading: undefined };
      if (guest === undefined || guest === null) return identity;
      try {
        if (typeof guest.getURL === 'function') identity.url = guest.getURL();
      } catch {
        // A wedged guest may throw; keep it undefined.
      }
      try {
        if (typeof guest.getTitle === 'function') identity.title = guest.getTitle();
      } catch {
        // Same.
      }
      return identity;
    }

    /**
     * The Session a provider query acts on. Cordis Client queries carry the
     * requesting Agent's Session; without one a Sidebar command has no target.
     */
    function sessionOf(context) {
      const sessionId = context?.sessionId;
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error('the Sidebar control plane needs a Session-backed Agent to know which Sidebar to act on');
      }
      return sessionId;
    }

    /** Sidebar service, or a clear error when the composition does not mount it. */
    function sidebarOf(ctx) {
      const sidebar = ctx.sidebarRight;
      if (sidebar === undefined || sidebar === null) {
        throw new Error('the Sidebar service (ctx.sidebarRight) is not available in this composition');
      }
      return sidebar;
    }

    /** Try a read-only sidebar getter, returning undefined when it throws. */
    function attempt(read) {
      try {
        return read();
      } catch {
        return undefined;
      }
    }

    /** Current on-screen Session id, if the Sidebar knows one. */
    function onScreenSession(ctx) {
      const sidebar = ctx.sidebarRight;
      const mounted = sidebar?.mounted;
      if (mounted === undefined || mounted === null) return undefined;
      if (typeof mounted.getSnapshot === 'function') {
        const value = attempt(() => mounted.getSnapshot());
        return typeof value === 'string' && value !== '' ? value : undefined;
      }
      return undefined;
    }

    /** Inventory entries of one Session (kind/contentId metadata only). */
    function inventoryOf(ctx, sessionId) {
      const sidebar = ctx.sidebarRight;
      const snapshot = attempt(() => sidebar?.openTabs?.getSnapshot?.()) ?? [];
      if (!Array.isArray(snapshot)) return [];
      return snapshot.filter((entry) => entry?.sessionId === sessionId);
    }

    /** Committed layout records of one Session, when its store was adopted. */
    function committedOf(ctx, sessionId) {
      const sidebar = ctx.sidebarRight;
      const records = attempt(() => sidebar?.tabsIn?.(sessionId));
      return Array.isArray(records) ? records : [];
    }

    /**
     * Describe a Session's tabs: identity from the inventory + committed layout,
     * mount/visibility from the live DOM, URL/title from a browser guest.
     */
    function describeSession(ctx, sessionId) {
      const isOnScreen = onScreenSession(ctx) === sessionId;
      const wrappers = tabWrappers(sessionId);
      const committed = new Map(committedOf(ctx, sessionId).map((record) => [record?.id, record]));
      // `active()` and `isExpanded()` describe the on-screen Sidebar only; for
      // any other Session they would be another Session's answers, so they stay
      // undefined instead of being attributed to the wrong tree.
      const activeTab = isOnScreen ? attempt(() => ctx.sidebarRight?.active?.()) : undefined;
      const activeId = typeof activeTab?.id === 'string' ? activeTab.id : undefined;
      const tabs = inventoryOf(ctx, sessionId).map((entry) => {
        const tabId = String(entry.tabId ?? '');
        const wrapper = wrappers.get(tabId);
        const committedRecord = committed.get(tabId);
        const kind = String(entry.kind ?? committedRecord?.kind ?? 'unknown');
        const contentId = typeof entry.contentId === 'string' ? entry.contentId : committedRecord?.contentId;
        const guest = kind === 'browser' ? browserGuest(wrapper) : undefined;
        const identity = guestIdentity(guest);
        // A browser tab is mounted only when its guest exists; a bare chip does
        // not render the page. Other kinds own no guest marker we can read, so
        // the wrapper is the best mount signal available there.
        const mounted = kind === 'browser' ? guest !== undefined : wrapper !== undefined;
        const parsed = kind === 'file' || (typeof contentId === 'string' && contentId.startsWith(FILE_ADDRESS_PREFIX)) ? parseFileAddress(contentId) : undefined;
        return {
          tabId,
          sessionId,
          kind,
          title: identity.title || committedRecord?.title || '',
          url: identity.url,
          contentId,
          path: parsed?.path,
          mounted,
          drawn: isDrawn(wrapper),
          hasGuest: guest !== undefined,
          active: tabId !== '' && tabId === activeId,
        };
      });
      const tabsById = new Map(tabs.map((tab) => [tab.tabId, tab]));
      // A tab that exists in the DOM but not in the inventory (or vice versa) is
      // still worth reporting: the inventory is the authority for identity, the
      // DOM is the authority for "mounted".
      return {
        sessionId,
        onScreen: isOnScreen,
        expanded: isOnScreen ? attempt(() => ctx.sidebarRight?.isExpanded?.()) : undefined,
        activeTabId: activeId,
        tabs,
        tabsById,
      };
    }

    /** Every Session with at least one open tab, newest inventory first. */
    function sessionsWithTabs(ctx) {
      const snapshot = attempt(() => ctx.sidebarRight?.openTabs?.getSnapshot?.()) ?? [];
      if (!Array.isArray(snapshot)) return [];
      const seen = new Set();
      const out = [];
      for (const entry of snapshot) {
        const sessionId = entry?.sessionId;
        if (typeof sessionId !== 'string' || sessionId === '' || seen.has(sessionId)) continue;
        seen.add(sessionId);
        out.push(sessionId);
      }
      return out;
    }

    /** Sidebar reads never return the raw store: only plain JSON crosses the channel. */
    function plain(value) {
      return JSON.parse(JSON.stringify(value));
    }

    // ---------------------------------------------------------------------
    // Provider methods
    // ---------------------------------------------------------------------

    /** `status`: the tab tree of the requesting Session, or of every Session. */
    function statusView(ctx, input, context) {
      const requested = typeof input?.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : sessionOf(context);
      const includeAll = input?.includeAllSessions === true;
      const sessionIds = includeAll ? [...new Set([...sessionsWithTabs(ctx), requested])] : [requested];
      const sessions = sessionIds.map((sessionId) => {
        const described = describeSession(ctx, sessionId);
        return {
          sessionId,
          onScreen: described.onScreen,
          expanded: described.expanded === undefined ? undefined : described.expanded === true,
          activeTabId: described.activeTabId,
          tabs: described.tabs,
        };
      });
      return plain({
        requestedSessionId: requested,
        onScreen: sessions.some((session) => session.sessionId === requested && session.onScreen),
        onScreenSessionId: onScreenSession(ctx),
        sessions,
      });
    }

    /**
     * Sidebar commands act on the Session whose Sidebar is drawn. A command for
     * any other Session has no adopted store to write into; say that plainly
     * instead of reporting a request that silently went nowhere.
     */
    function requireOnScreen(ctx, sessionId, action) {
      const onScreen = onScreenSession(ctx);
      if (onScreen === sessionId) return;
      const where = onScreen === undefined ? 'no Session is on screen' : `the on-screen Session is ${onScreen.slice(0, 8)}…`;
      throw new Error(
        `sidebar ${action}: this Session's Sidebar is not on screen (${where}). Sidebar commands act on the on-screen Session only — switch DSH to the Session whose Sidebar is visible, then retry.`,
      );
    }

    /** Wait briefly for a newly opened tab to appear in the inventory. */
    async function waitForNewTab(ctx, sessionId, before, timeoutMs) {
      const started = Date.now();
      for (;;) {
        const fresh = inventoryOf(ctx, sessionId).find((entry) => !before.has(String(entry.tabId ?? '')));
        if (fresh !== undefined) return fresh;
        if (Date.now() - started >= timeoutMs) return undefined;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    /** `open`: open a browser/file/terminal/guide tab in the requesting Session. */
    async function openView(ctx, input, context) {
      const sessionId = sessionOf(context);
      const sidebar = sidebarOf(ctx);
      requireOnScreen(ctx, sessionId, 'open');
      const kind = String(input?.kind ?? '');
      if (!OPEN_KINDS.includes(kind)) throw new Error(`sidebar open: kind must be one of ${OPEN_KINDS.join(', ')}`);
      const before = new Set(inventoryOf(ctx, sessionId).map((entry) => String(entry.tabId ?? '')));
      let address;
      let params;
      if (kind === 'browser') {
        const url = String(input?.url ?? '').trim();
        if (url === '') throw new Error('sidebar open: url is required for kind "browser"');
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error(`sidebar open: "${url}" is not a valid URL`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`sidebar open: url must use http:// or https://, got ${parsed.protocol}//`);
        sidebar.openTab('browser', { params: { url: parsed.href } });
        address = parsed.href;
      } else if (kind === 'file') {
        const path = String(input?.path ?? '').trim();
        if (path === '') throw new Error('sidebar open: path is required for kind "file"');
        address = sessionFileAddress(sessionId, path);
        params = Number.isFinite(input?.line) ? { line: Math.round(Number(input.line)) } : undefined;
        sidebar.openResource(address, params === undefined ? {} : { params });
      } else if (kind === 'terminal') {
        const shellPath = typeof input?.shellPath === 'string' && input.shellPath !== '' ? input.shellPath : undefined;
        sidebar.openTab('terminal', shellPath === undefined ? {} : { params: { shellPath } });
      } else {
        sidebar.openTab('guide', {});
      }
      const fresh = await waitForNewTab(ctx, sessionId, before, 1500);
      return plain({
        kind,
        tabKind: fresh === undefined ? undefined : String(fresh.kind ?? ''),
        sessionId,
        address,
        params,
        tabId: fresh === undefined ? undefined : String(fresh.tabId ?? ''),
        pending: fresh === undefined,
        note: fresh === undefined ? 'the tab was requested but has not appeared in the inventory yet; call status to confirm' : undefined,
      });
    }

    /** `focus`: reveal one tab of the requesting Session. */
    function focusView(ctx, input, context) {
      const sessionId = sessionOf(context);
      const sidebar = sidebarOf(ctx);
      requireOnScreen(ctx, sessionId, 'focus');
      const tabId = String(input?.tabId ?? '');
      if (tabId === '') throw new Error('sidebar focus: tabId is required');
      const known = inventoryOf(ctx, sessionId).some((entry) => String(entry.tabId ?? '') === tabId);
      if (!known) throw new Error(`sidebar focus: no tab "${tabId}" in this Session; call sidebar status first`);
      const focused = attempt(() => sidebar.focus(tabId));
      return plain({ tabId, sessionId, focused: focused !== false, onScreen: onScreenSession(ctx) === sessionId });
    }

    /** `close`: remove one tab of the requesting Session. */
    function closeView(ctx, input, context) {
      const sessionId = sessionOf(context);
      const sidebar = sidebarOf(ctx);
      requireOnScreen(ctx, sessionId, 'close');
      const tabId = String(input?.tabId ?? '');
      if (tabId === '') throw new Error('sidebar close: tabId is required');
      const known = inventoryOf(ctx, sessionId).some((entry) => String(entry.tabId ?? '') === tabId);
      if (!known) throw new Error(`sidebar close: no tab "${tabId}" in this Session; call sidebar status first`);
      sidebar.close(tabId);
      return plain({ tabId, sessionId, closed: true });
    }

    /** `expand`: everything cheaply knowable about one tab, for the model's next step. */
    function expandView(ctx, input, context) {
      const sessionId = sessionOf(context);
      const tabId = String(input?.tabId ?? '');
      requireOnScreen(ctx, sessionId, 'expand');
      if (tabId === '') throw new Error('sidebar expand: tabId is required');
      const described = describeSession(ctx, sessionId);
      const tab = described.tabsById.get(tabId);
      if (tab === undefined) throw new Error(`sidebar expand: no tab "${tabId}" in this Session; call sidebar status first`);
      return plain({ ...tab, onScreen: described.onScreen });
    }

    // ---------------------------------------------------------------------
    // Inspect provider
    // ---------------------------------------------------------------------

    const ANY_OUTPUT = { description: 'JSON data produced by the Sidebar control plane.' };

    /** Build the single Client provider this plugin registers. */
    function buildProvider(ctx) {
      return {
        manifest: {
          id: PROVIDER,
          description: 'Read and navigate the right Sidebar: list its tabs across kinds (browser/terminal/file/guide), open, focus, close and expand one tab.',
          methods: [
            {
              name: 'status',
              description: 'List the Sidebar tabs of a Session as a tree: kind, title, url/path, active, mounted, drawn.',
              inputSchema: {
                type: 'object',
                properties: {
                  sessionId: { type: 'string', description: 'Session to describe; defaults to the requesting Session.' },
                  includeAllSessions: { type: 'boolean', description: 'Include Sessions other than the requesting one.' },
                },
                additionalProperties: false,
              },
              outputSchema: ANY_OUTPUT,
            },
            {
              name: 'open',
              description: 'Open a tab: a browser URL, a file preview, a terminal, or the guide.',
              inputSchema: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: OPEN_KINDS, description: 'Tab kind to open.' },
                  url: { type: 'string', description: 'HTTP(S) URL for kind "browser".' },
                  path: { type: 'string', description: 'Absolute or workspace-relative path for kind "file".' },
                  line: { type: 'number', description: 'One-based source line for kind "file".' },
                  shellPath: { type: 'string', description: 'Shell executable for kind "terminal"; the Sidebar default when omitted.' },
                },
                required: ['kind'],
                additionalProperties: false,
              },
              outputSchema: ANY_OUTPUT,
            },
            {
              name: 'focus',
              description: 'Reveal and focus one tab of the requesting Session.',
              inputSchema: {
                type: 'object',
                properties: { tabId: { type: 'string', description: 'Tab id from status.' } },
                required: ['tabId'],
                additionalProperties: false,
              },
              outputSchema: ANY_OUTPUT,
            },
            {
              name: 'close',
              description: 'Close one tab of the requesting Session.',
              inputSchema: {
                type: 'object',
                properties: { tabId: { type: 'string', description: 'Tab id from status.' } },
                required: ['tabId'],
                additionalProperties: false,
              },
              outputSchema: ANY_OUTPUT,
            },
            {
              name: 'expand',
              description: 'Describe one tab in full: identity, mount state, and the path/url needed to read its content with the right tool.',
              inputSchema: {
                type: 'object',
                properties: { tabId: { type: 'string', description: 'Tab id from status.' } },
                required: ['tabId'],
                additionalProperties: false,
              },
              outputSchema: ANY_OUTPUT,
            },
          ],
        },
        async query(method, input, context) {
          switch (method) {
            case 'status':
              return statusView(ctx, input, context);
            case 'open':
              return openView(ctx, input, context);
            case 'focus':
              return focusView(ctx, input, context);
            case 'close':
              return closeView(ctx, input, context);
            case 'expand':
              return expandView(ctx, input, context);
            default:
              throw new Error(`${PROVIDER} has no method "${method}"`);
          }
        },
      };
    }

    /** Required Client services: the inspect registry and the Sidebar controller. */
    const inject = ['cordisInspect', 'sidebarRight'];

    /** Register the provider under the plugin's lifetime. */
    function apply(ctx) {
      ctx.effect(() => ctx.cordisInspect.register(buildProvider(ctx)), 'dsh-sidebar-control: provider');
    }

    module.exports = {
      name: 'dsh-sidebar-control',
      inject,
      apply,
      // Test surface: pure helpers and the provider builder, never used in production.
      __test: {
        buildProvider,
        sessionFileAddress,
        parseFileAddress,
        encodeSegment,
        encodePath,
        isDrawn,
        PROVIDER,
      },
    };
    return module.exports;
  },
});





