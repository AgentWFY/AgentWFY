# Page-Centric Architecture Plan

This document maps the current tab implementation and proposes a replacement
architecture where agents work with **pages**. A **tab** becomes only one UI
presentation for user-facing pages, mainly on desktop.

This is a planning document only. It does not require implementation changes
yet. It is written after tracing the current desktop, server, shared runtime,
remote backend, and mobile code paths.

## Goals

- Make the agent-facing browser/page API obvious across desktop, mobile,
  remote daemon, and headless execution.
- Preserve the key workflow: the user has a page open and says, "look at the
  current page; something is broken."
- Stop leaking desktop-specific tab concepts into agent runtime APIs.
- Expose capabilities explicitly per page: screenshot, CDP, input, console
  logs, etc.
- Separate page lifecycle, browser automation, UI tab presentation, and
  platform-specific layout.
- Let mobile participate in the page model without pretending to support
  Electron `WebContentsView` tabs.
- Reduce duplicated idle-close, JS wrapping, and CDP subscription logic.

## Non-Goals

- No backward compatibility for the old **agent-facing** tab function names is
  required.
- This plan does not require desktop to stop rendering tabs. Tabs remain a
  desktop UI presenter detail.
- This plan does not require mobile to support multiple live background pages
  in the first implementation.
- This plan does not require daemon headless pages to silently mimic client-only
  browser capabilities such as native mobile rendering.

## Current Implementation

### Current Runtime API

The current agent-facing API is tab-centric:

- `getTabs`
- `getCurrentTab`
- `openTab`
- `closeTab`
- `selectTab`
- `reloadTab`
- `captureTab`
- `execTabJs`
- `sendInput`
- `inspectElement`
- `getTabConsoleLogs`
- `tabDebuggerSend`
- `tabDebuggerSubscribe`
- `tabDebuggerPoll`
- `tabDebuggerUnsubscribe`
- `tabDebuggerDetach`

The shared runtime interfaces live mainly in:

- `shared/runtime/hosts.ts`
- `shared/runtime/tab-router.ts`
- `shared/runtime/functions/tabs.ts`
- `shared/browser/cdp-ops.ts`

Important current types:

- `TabApi`
- `VisibleTabHost`
- `BrowserHost`
- `BrowserPageHandle`
- `TabData`

Current routing:

```txt
Agent function call
  -> FunctionRegistry
  -> registerTabs()
  -> TabApi
  -> TabRouter
       -> VisibleTabHost
       -> BrowserHost
       -> ClientFunctionInvoker
```

### Desktop Local Agents

For a local desktop agent, `AgentContextFactory` creates a `TabViewManager` and
wraps it with `TabRouter`:

```txt
Local desktop runtime
  -> TabRouter
       visibleTabHost -> TabViewManager
       browserHost    -> ElectronBrowserHost -> TabViewManager
```

Main files:

- `desktop/agent-context-factory.ts`
- `desktop/tab-view-manager.ts`
- `desktop/electron-browser-host.ts`
- `desktop/ipc/tabs.ts`
- `desktop/ipc/tab-views.ts`
- `desktop/renderer/components/tabs.ts`
- `desktop/renderer/components/tab_view.ts`

`TabViewManager` currently owns too much:

- Electron `WebContentsView` creation and destruction.
- User-facing tab state and selected tab state.
- Headless/off-screen view placement.
- Bounds, z-order, active-agent collapse, and zen-mode collapse.
- JavaScript execution.
- Screenshots.
- Input dispatch.
- Console log buffering.
- CDP debugger attach, send, subscribe, poll, and detach.
- Idle-close timers for headless tabs.
- View-source update state (`viewChanged`).
- Pinning, reorder, context menu, reload, devtools, and keyboard tab actions.
- `WebContents` tracking for agent-view runtime IPC routing.

### Desktop Renderer

The desktop renderer has two pieces:

- `<awfy-tabs>` renders the tab bar and one panel per non-headless tab.
- `<awfy-tab-view>` measures the DOM rectangle where the native page should be
  placed and reports it to main.

The actual page is not DOM inside the renderer. It is a main-process
`WebContentsView`, so bounds are synchronized through IPC:

```txt
<awfy-tab-view>
  -> ResizeObserver / MutationObserver / RAF / fallback timer
  -> ipc.tabs.updateViewBounds({ tabId, bounds, visible })
  -> TabViewManager.setTabViewBounds()
  -> WebContentsView.setBounds(...)
```

Headless tabs are filtered out of the tab bar.

### Local Desktop Headless Tabs

Desktop "headless" tabs are not truly headless. They are hidden
`WebContentsView` instances attached to the window:

- They are not rendered in the desktop tab bar.
- They are moved to `CAPTURE_OFFSCREEN_OFFSET = -30000`.
- They must stay `setVisible(true)` so `capturePage()` keeps working.
- They use CDP `Emulation.setDeviceMetricsOverride` for viewport sizing.
- They participate in child-view stacking.
- They are affected by Electron compositor behavior.
- They auto-close after idle unless `closeAfterIdleMs: 'never'`.

This is very different from daemon Chrome pages, which are true headless CDP
targets.

### Remote Agents

For remote agents, the daemon owns the runtime and the desktop app is a
connected client.

On the daemon:

- `server/runtime-bootstrap.ts` creates a `TabRouter`.
- `HeadlessChromeBrowserHost` is used if Chrome/CDP is configured.
- Visible tab operations are proxied back to the connected client through
  `client.functions.invoke`.

```txt
Remote daemon runtime
  -> TabRouter
       browserHost   -> HeadlessChromeBrowserHost
       clientInvoker -> ConnectedClientBridge -> desktop client
```

For `headless: true`, the daemon opens a Chrome/CDP page.

For `headless: false`, the daemon calls the connected desktop client through
generic function RPC. On desktop, `createRemoteAgentContext()` builds a
client-side `FunctionRegistry`, registers tab functions, and those functions
call the desktop `TabViewManager`.

Main files:

- `server/runtime-bootstrap.ts`
- `server/headless-chrome.ts`
- `server/client-bridge.ts`
- `desktop/agent-context-remote.ts`
- `shared/backend/remote.ts`
- `shared/backend/protocol.ts`

### Daemon Headless Chrome

`server/headless-chrome.ts` implements true headless pages through CDP:

- Launches or connects to Chrome.
- Creates a target with `Target.createTarget`.
- Attaches with `Target.attachToTarget`.
- Applies viewport with `Emulation.setDeviceMetricsOverride`.
- Navigates with `Page.navigate`.
- Captures screenshots with `Page.captureScreenshot`.
- Executes JS with `Runtime.evaluate`.
- Tracks console logs.
- Buffers and polls CDP subscriptions.
- Handles idle auto-close.

Important limitation found during code review: daemon headless view/file pages
currently load as `data:` URLs built from `buildViewDocument()`. That means
they do **not** naturally share desktop/mobile view-origin behavior, asset
routing, module routing, or `window.agentwfy` runtime behavior. This is a bug:
all AgentWFY-rendered view documents must expose `window.agentwfy` regardless
of renderer.

### Mobile Today

Mobile has no tab/page manager today. It has one active view frame:

- `mobile/src/components/app.ts`
- `mobile/src/components/view_frame.ts`
- `mobile/src/components/view_list.ts`
- `mobile/src/agent-view-bridge.ts`

Current mobile state:

```ts
activeViewName: string | null
activeViewVersion: number
```

The view frame renders:

```txt
<iframe src="agentview://localhost/view/{name}?tabId=mobile-view&rev={version}">
```

Mobile is remote-only today. It uses `RemoteBackend`, `MobileRemoteMirror`, a
Tauri SQLite mirror, and a `postMessage` bridge for view calls. It has no local
CDP, no Electron `WebContentsView`, no true local headless support, and no
agent-controlled JS injection into the iframe from the runtime.

## Why The Current Architecture Is Not Suitable

### 1. "Tab" Conflates Several Concepts

Today, "tab" means:

1. A browser/page context the agent can control.
2. A desktop UI tab.
3. A selected/current user-facing page.
4. A hidden/off-screen desktop automation target.
5. A daemon headless Chrome page.
6. A remote client-hosted page.

`TabData` mixes runtime state and UI presenter state:

- Runtime/page fields: `type`, `target`, `viewport`, `headless`,
  `closeAfterIdleMs`, `expiresAt`, `openedAt`, `lastUsedAt`.
- UI fields: `pinned`, `selected`, `viewChanged`.
- Compatibility duplication: `id` and `tabId`.

### 2. `headless: boolean` Is The Wrong Primitive

A desktop tab that is not selected is not headless. The user can switch to it.
It is a background user-facing page.

The important distinctions are:

- The page is selected on a user-facing surface.
- The page exists on a user-facing surface but is not selected.
- The page has no user-facing surface.

`headless: false` only means "this appears in the desktop tab bar" today. It
does not mean "the user is currently looking at it."

### 3. The Current-Page Workflow Must Stay First-Class

The replacement must preserve:

> User has a page open, opens chat, and says: "look at the current page; something is broken."

`getCurrentTab()` supports this today. The new API needs `getCurrentPage()`.
Listing pages with `display: 'foreground'` is not enough unless foreground is
defined relative to a concrete client/surface.

### 4. Local Desktop Headless Behavior Leaks Electron Details

Desktop hidden tabs depend on `WebContentsView` compositor behavior:

- Off-screen placement.
- `setVisible(true)` for capture.
- Child-view z-order.
- Active-agent collapse to `0x0`.
- CDP attachment for viewport emulation.
- Retry loops around capture and reload races.

This needs to be isolated behind a desktop host/layout implementation.

### 5. Remote Visible Page Routing Is Too Generic

Remote visible operations currently go through:

```txt
client.functions.invoke("openTab", ...)
```

Pages are a core subsystem and need typed protocol methods. They should not be
hidden inside generic function invocation.

### 6. Capabilities Are Implicit

Today callers infer support from host behavior:

- Desktop visible tabs usually support CDP.
- Daemon headless pages support CDP only if Chrome is configured.
- Mobile iframes do not support CDP, screenshots, native input, or agent-side
  JS injection today.
- Daemon data-URL views currently miss `window.agentwfy`; that is an invariant
  violation to fix, not a capability difference to expose.

Capabilities should be explicit per page.

### 7. Duplicate Logic Exists Across Backends

Duplicated areas:

- Idle close in `TabViewManager` and `HeadlessChromeBrowserHost`.
- CDP subscription buffering/polling in desktop and daemon paths.
- JS expression/body wrapping in desktop and CDP paths.
- Console log normalization.
- Input event normalization.

These should become shared page/browser utilities where practical.

## Proposed Model

### Terminology

- **Page**: a browser/view context that can load a source and may support
  operations such as screenshot capture, JavaScript execution, input, console
  logs, inspection, CDP, or view-authored `window.agentwfy` calls.
- **Page host**: the backend that owns the concrete page implementation, such
  as Electron `WebContentsView`, daemon Chrome, mobile iframe, or a remote
  client proxy.
- **Page surface**: a user-facing presentation area on a client. Desktop's tab
  area is one page surface. Mobile's view frame is one page surface.
- **Foreground page**: the selected page on a page surface.
- **Background page**: a user-facing page on a page surface that is not
  selected.
- **Headless page**: a page with no user-facing surface.
- **Tab**: a desktop UI item representing a user-facing page. It is not an
  agent runtime primitive.

### Display Model

Use an explicit display enum:

```ts
type PageDisplay = 'foreground' | 'background' | 'headless'
```

Meaning:

| Display | User-facing entry | Selected on surface | Agent-only |
|---------|-------------------|---------------------|------------|
| `foreground` | yes | yes | no |
| `background` | yes | no | no |
| `headless` | no | no | yes |

Important nuance: `foreground` means selected on the owning page surface. It
does not always guarantee the pixels are physically visible. For example, the
desktop app can be hidden, zen mode can collapse the page area, or an inactive
agent's selected page can be parked at `0x0`. `PageInfo` should therefore
include presentation visibility metadata separately.

### Source Model

Replace "exactly one of `viewName`, `filePath`, or `url`" with a discriminated
source object:

```ts
type PageSource =
  | { type: 'view'; name: string; params?: Record<string, string> }
  | { type: 'file'; path: string; params?: Record<string, string> }
  | { type: 'url'; url: string }
```

Validation rules:

- `view` must resolve through the agent DB.
- `file` means "render this UTF-8 file as an AgentWFY view document" and should
  use the existing path policy. Binary file viewing is not implied.
- Direct browser navigation to a `file:` URL, if supported by the host, should
  use `source: { type: 'url', url: 'file://...' }`.
- `url` must be absolute and use a host-supported scheme. Desktop currently
  supports `http:`, `https:`, and `file:` for URL tabs.
- `params` apply only to `view` and `file` sources and are serialized with
  `URLSearchParams`.
- Host-specific URL construction belongs in source resolver/adapters, not in
  agent-facing function code.

### AgentWFY View Runtime Invariant

Every page that renders an AgentWFY view document must expose
`window.agentwfy` before user view scripts run.

This applies to:

- Desktop foreground/background view pages.
- Desktop headless view pages.
- Daemon Chrome headless view pages.
- Mobile iframe/WebView view pages.
- File-backed pages when they are rendered through AgentWFY's view document
  wrapper.

This is not a page capability. It is part of the contract for rendering
AgentWFY view documents. If a host cannot provide `window.agentwfy` for a view
document, that host has a bug or should fail the view load instead of reporting
a degraded capability.

External URL pages must not receive `window.agentwfy`.

### Capabilities

Capabilities should describe what works for this exact page right now:

```ts
interface PageCapabilities {
  screenshot: boolean
  js: boolean
  input: boolean
  consoleLogs: boolean
  inspect: boolean
  cdp: boolean
  screencast: boolean
}
```

Definitions:

- `screenshot`: agent can capture this page.
- `js`: agent can run JavaScript in this page from outside the page.
- `input`: agent can dispatch browser input events.
- `consoleLogs`: agent can read buffered page logs.
- `inspect`: agent can inspect DOM/layout data through a supported operation.
- `cdp`: agent can send Chrome DevTools Protocol commands.
- `screencast`: page can provide CDP or equivalent screencast frames.

Example capabilities:

#### Desktop view/file page

```ts
{
  screenshot: true,
  js: true,
  input: true,
  consoleLogs: true,
  inspect: true,
  cdp: true,
  screencast: false
}
```

#### Desktop external URL page

```ts
{
  screenshot: true,
  js: true,
  input: true,
  consoleLogs: true,
  inspect: true,
  cdp: true,
  screencast: false
}
```

#### Mobile iframe view page today

```ts
{
  screenshot: false,
  js: false,
  input: false,
  consoleLogs: false,
  inspect: false,
  cdp: false,
  screencast: false
}
```

Mobile view pages can call the runtime through the existing `postMessage`
bridge, but the agent runtime cannot currently inject JS into that iframe or
capture it natively.

#### Daemon Chrome headless page today

```ts
{
  screenshot: true,
  js: true,
  input: true,
  consoleLogs: true,
  inspect: true,
  cdp: true,
  screencast: true
}
```

### Lifecycle

Use lifecycle as a separate concept from display:

```ts
type PageLifecycle =
  | 'opening'
  | 'ready'
  | 'failed'
  | 'suspended'
  | 'unavailable'
  | 'crashed'
  | 'closed'
```

Meanings:

- `opening`: host created the page, navigation/load is in progress.
- `ready`: page is live and operations may run if capabilities allow them.
- `failed`: initial load or reload failed. Include error metadata.
- `suspended`: metadata exists, but the live renderer may have been released.
  Mobile background pages should use this if implemented later.
- `unavailable`: owning host/client is disconnected. Remote client-hosted
  pages should enter this state on disconnect rather than being assumed closed.
- `crashed`: renderer/target crashed.
- `closed`: terminal state. Closed pages should be removed from normal
  `getPages()` results after a close event is emitted.

### PageInfo

Agent-facing page metadata:

```ts
interface PageInfo {
  pageId: string
  title: string
  source: PageSource
  currentUrl?: string
  display: PageDisplay
  lifecycle: PageLifecycle
  capabilities: PageCapabilities
  viewport?: { width: number; height: number }
  owner: {
    agentId: string
    hostKind: 'desktop' | 'desktop-headless' | 'mobile' | 'daemon-headless' | 'remote-client'
    client?: {
      id: string
      kind: 'desktop' | 'mobile' | 'web'
      activeForAgent: boolean
    }
  }
  presentation?: {
    surfaceId: string
    visibleNow: boolean
    visibilityReason?: 'visible' | 'inactive-agent' | 'collapsed' | 'hidden-window' | 'suspended'
  }
  createdBy: 'agent' | 'user' | 'system'
  content?: {
    stale: boolean
    version?: number
  }
  openedAt: number
  lastUsedAt?: number
  closeAfterIdleMs?: number | 'never'
  expiresAt?: number
  lastError?: {
    message: string
    code?: string | number
  }
}
```

Presenter-only fields such as tab order, pinned state, drag state, and context
menu state should live in presenter state, not in `PageInfo`.

`content.stale` replaces the runtime need for `viewChanged`. Desktop tabs can
still render a changed dot from presenter state derived from page/source events.

### Page IDs And Ownership

Rules:

- Page IDs must not be reused within a `PageManager` lifetime.
- `PageManager` should normally generate IDs and pass them to the selected
  host.
- For daemon-opened remote client pages, the daemon `PageManager` should
  generate the `pageId`; the client must create its local page with that ID.
- For pages created directly by a client UI, the client `PageManager` may
  generate the `pageId`; the daemon should mirror it through typed page
  snapshot/events.
- A page has exactly one owning host.
- Operations route by `pageId` to that owning host.
- Closing a page closes CDP subscriptions, idle timers, console buffers, and
  host resources associated with that page.

## Agent-Facing Page API

Recommended low-level runtime API:

```ts
getPages(request?: {
  display?: PageDisplay | 'user-facing' | 'all'
  clientId?: string
}): Promise<PageInfo[]>

getCurrentPage(request?: {
  clientId?: string
}): Promise<PageInfo | null>

openPage(request: {
  source: PageSource
  display: PageDisplay
  title?: string
  viewport?: 'mobile' | 'tablet' | 'desktop' | { width?: number; height?: number }
  closeAfterIdleMs?: number | 'never'
}): Promise<{ pageId: string; page: PageInfo; info: string }>

showPage(request: { pageId: string }): Promise<PageInfo>
closePage(request: { pageId: string }): Promise<void>
reloadPage(request: { pageId: string }): Promise<PageInfo>
waitForPage(request: { pageId: string; lifecycle?: 'ready'; timeoutMs?: number }): Promise<PageInfo>

capturePage(request: {
  pageId: string
  allowFallback?: boolean
}): Promise<PageScreenshot>

runPageJs(request: { pageId: string; code: string; timeoutMs?: number }): Promise<unknown>
sendPageInput(request: PageInputRequest): Promise<void>
inspectPageElement(request: { pageId: string; selector: string }): Promise<unknown>
getPageConsoleLogs(request: { pageId: string; since?: number; limit?: number }): Promise<ConsoleLog[]>

sendPageCdp(request: { pageId: string; method: string; params?: unknown; sessionId?: string }): Promise<unknown>
subscribePageCdp(request: { pageId: string; events: string[] }): Promise<{ subscriptionId: string }>
pollPageCdp(request: { subscriptionId: string; maxBatch?: number; maxWaitMs?: number }): Promise<CdpPollResult>
unsubscribePageCdp(request: { subscriptionId: string }): Promise<void>
detachPageCdp(request: { pageId: string }): Promise<void>
```

`PageInputRequest` should include `pageId` plus the normalized input event
fields currently used by `sendInput`.

Screenshot result:

```ts
interface PageScreenshot {
  base64: string
  mimeType: 'image/png'
  pageId: string
  capturedPageId: string
  fallback?: {
    hostKind: string
    reason: string
  }
}
```

`capturedPageId` is normally the same as `pageId`. If an explicit fallback is
used, it identifies the actual page that produced the screenshot.

### API Policy

- `getPages()` should default to `display: 'all'` for agent runtime calls so
  agents can manage headless pages they opened. UI presenters can request only
  `user-facing` pages.
- `getCurrentPage()` returns the foreground page for the current relevant
  client/surface, or `null`.
- `openPage({ display: 'foreground' })` requires a user-facing page surface.
  If no suitable client/surface is available, it must fail clearly.
- `openPage({ display: 'background' })` requires a client/surface that supports
  background pages. If the host does not support background pages, it must fail
  clearly rather than silently foregrounding.
- `openPage({ display: 'headless' })` requires a headless-capable host.
- `showPage()` only applies to foreground/background user-facing pages. Calling
  it on a headless page should fail unless a future explicit "materialize" API
  is added.
- Operations must validate capabilities before dispatch. For example,
  `capturePage()` on a mobile iframe should fail unless `allowFallback` is true
  and a fallback host is available.
- Fallback capture must be opt-in and must return fallback metadata. Silent
  fallback is misleading because daemon rendering may not match client session
  state, cookies, viewport, fonts, platform CSS, or view runtime state.
- CDP subscriptions are globally identified by `subscriptionId` within the
  `PageManager`. They close on page close, detach, host disconnect, or crash.
- If a presenter marks a page as protected from close, `closePage()` should
  return a clear blocked error rather than silently succeeding. Whether desktop
  tab pinning should count as such protection is an open decision below.

### Runtime Binding Defaults

This is the main behavior that should be confirmed before implementation.

Recommended rule:

- The low-level agent-facing `openPage()` function requires `display`.
- Higher-level UI/view helpers may pass explicit defaults:
  - agent automation helper: `display: 'headless'`
  - view/UI navigation helper: `display: 'foreground'`

This keeps `PageManager` deterministic and avoids hiding different defaults in
different hosts. It also preserves the current practical split where agent
`execJs` defaults `openTab` to headless and view runtime calls default to
visible tabs.

## Clean Break From Tab Runtime API

Remove agent-facing functions:

- `getTabs`
- `getCurrentTab`
- `openTab`
- `closeTab`
- `selectTab`
- `reloadTab`
- `captureTab`
- `execTabJs`
- `getTabConsoleLogs`
- `sendInput`
- `inspectElement`
- `tabDebuggerSend`
- `tabDebuggerSubscribe`
- `tabDebuggerPoll`
- `tabDebuggerUnsubscribe`
- `tabDebuggerDetach`

Replace them with page functions only.

Also update these related surfaces:

- `shared/runtime/types.ts` worker method map.
- `shared/runtime/daemon-functions.ts`.
- `shared/runtime/exec_worker.mts` special bindings:
  - `capturePage` should auto-attach image files like `captureTab` does now.
  - `subscribePageCdp` should return the async iterable handle currently built
    for `tabDebuggerSubscribe`.
  - Any defaulting behavior for `openPage` must be explicit and documented.
- `shared/system-docs/system.tabs.md` and
  `shared/system-docs/system.tab-debugger.md` should be replaced with page
  docs.
- System views and renderer code that call `window.agentwfy.openTab` or
  `window.ipc.tabs.openTab` for page navigation should move to page-named
  APIs.

Desktop UI-only channels may stay tab-named where they truly only control the
tab presenter, such as reorder/pin/context menu. Runtime-facing or page
lifecycle channels should be page-named.

## Proposed Architecture

### High-Level Layers

```txt
Agent runtime
  -> Page API functions
  -> PageManager
  -> PageHost adapters
       -> DesktopPageHost
       -> ElectronHeadlessPageHost
       -> DaemonHeadlessPageHost
       -> RemoteClientPageHost
       -> MobilePageHost
  -> Page presenters
       -> DesktopTabPresenter
       -> MobilePagePresenter
  -> Platform layout/rendering
       -> DesktopPageLayout
       -> Mobile iframe/WebView frame
```

### PageManager

Shared, platform-neutral core.

Responsibilities:

- Generate and track page IDs.
- Own `PageInfo` metadata.
- Track lifecycle, capabilities, owner, source, display, and content staleness.
- Track current foreground page per page surface/client.
- Select a host for `openPage`.
- Route operations to the owning `PageHandle`.
- Validate capabilities before operations.
- Normalize source, viewport, close-after-idle, and errors.
- Touch pages on operations for idle-close behavior.
- Own or delegate CDP subscription lifecycle.
- Emit page events.
- Provide `getPages()` and `getCurrentPage()`.
- Mark client-hosted pages `unavailable` on disconnect and resync them on
  reconnect.

Must not:

- Import Electron, Tauri, DOM, or server-only APIs.
- Own tab order, pinned state, drag state, context menus, or other presenter
  state.
- Set native view bounds directly.

### PageHost

A host owns concrete pages in one environment.

```ts
interface PageHost {
  readonly hostKind: PageInfo['owner']['hostKind']

  canOpen(request: OpenPageRequest, context: PageOpenContext): boolean

  openPage(request: OpenPageRequest & {
    pageId: string
    owner: PageInfo['owner']
  }): Promise<PageHandle>

  getPage(pageId: string): PageHandle | null
  closePage(pageId: string): Promise<void>

  listPages?(): Promise<PageInfo[]>
  onPageEvent?(handler: (event: PageEvent) => void): () => void
}
```

### PageHandle

```ts
interface PageHandle {
  readonly pageId: string
  info(): PageInfo
  close(): Promise<void>
  reload(): Promise<void>

  capture?(): Promise<PageScreenshot>
  runJs?(code: string, timeoutMs?: number): Promise<unknown>
  sendInput?(input: PageInputRequest): Promise<void>
  inspectElement?(selector: string): Promise<unknown>
  getConsoleLogs?(request?: { since?: number; limit?: number }): Promise<ConsoleLog[]>
  sendCdp?(method: string, params?: unknown, sessionId?: string): Promise<unknown>
  subscribeCdp?(events: string[]): PageCdpSubscription
}
```

Optional methods derive capabilities. If a method is absent, the corresponding
capability should be false.

### Page Events

Suggested event types:

```txt
page.created
page.updated
page.closed
page.currentChanged
page.lifecycleChanged
page.capabilitiesChanged
page.contentStaleChanged
page.consoleLog
```

Events should include a monotonically increasing version per manager or per
surface so remote mirrors can resync cleanly.

## Host Responsibilities

### DesktopPageHost

Electron implementation for user-facing desktop pages.

Responsibilities:

- Create and destroy `WebContentsView` backed pages.
- Load `view`, `file`, and `url` sources through the correct agent session and
  protocol handler.
- Preserve per-agent session isolation.
- Preserve `webContentsId -> agent/page` sender registration for runtime IPC
  routing.
- Provide screenshot, JS, input, console, inspect, and CDP operations.
- Track page title, current URL, load failures, crashes, console logs, and
  content staleness.
- Expose `PageHandle`s to `PageManager`.

### ElectronHeadlessPageHost

Initial local desktop headless implementation, if true Chrome headless is not
used locally.

Responsibilities:

- Own hidden/off-screen `WebContentsView` pages.
- Keep Electron compositor workarounds inside this host/layout path.
- Apply viewport emulation.
- Support idle close.
- Avoid leaking headless pages into presenter tab state.

This can be a transitional host. It isolates today's "off-screen but attached"
behavior while leaving room for a true local Chrome/CDP host later.

### DesktopPageLayout

Desktop layout implementation.

Responsibilities:

- Attach/detach `WebContentsView` children.
- Apply bounds from renderer page placeholders.
- Handle z-order and overlay views.
- Keep inactive agent pages at `0x0`.
- Handle zen-mode/window-hidden collapse.
- Handle off-screen capture placement where Electron requires it.

It should not own page metadata or tab presenter state.

### DesktopTabPresenter

Desktop UI presenter.

Responsibilities:

- Render foreground/background user-facing pages as tabs.
- Own tab-specific state: pinned, order, drag state, context menu state.
- Send `showPage(pageId)` when the user selects a tab.
- Send page lifecycle actions when the user closes/reloads a tab.
- React to page events and update tab entries.
- Expose command-palette tab/page list entries.
- Keep keyboard shortcuts such as close/reload/next/previous tab working.
- Keep the headless-page status indicator working, renamed if desired.

`PageInfo` should not contain pinned or reorder state.

### DaemonHeadlessPageHost

Server implementation using Chrome/CDP.

Responsibilities:

- Launch/connect Chrome.
- Open headless pages.
- Provide screenshot, JS, input, console, inspect, CDP, and screencast.
- Use shared idle close and CDP subscription helpers.
- Expose accurate capabilities.
- Render AgentWFY view documents with `window.agentwfy`, module routing, file
  routing, params, and per-agent isolation. Current data-URL view loading does
  not satisfy this and should be fixed separately before or during the page
  architecture work.

### RemoteClientPageHost

Daemon-side proxy for pages hosted on a connected client.

Responsibilities:

- Route `foreground` and `background` page requests to a connected client.
- Fail clearly when no suitable client is connected.
- Use typed page RPC, not `client.functions.invoke`.
- Mirror client page snapshots/events into the daemon `PageManager`.
- Mark mirrored client pages `unavailable` on disconnect.
- Resync from the client on reconnect or client replacement.

### MobilePageHost

Mobile client implementation.

Initial scope:

- One foreground page backed by the existing `agentview://` iframe/WebView.
- `view` source support first.
- Preserve view-authored `window.agentwfy` calls through the existing
  `postMessage` bridge.
- No agent-side JS injection, screenshot, input, console logs, inspect, CDP, or
  background pages initially.

Later scope:

- Suspended background pages as metadata.
- A mobile page switcher.
- Optional native screenshot or inspection capability if Tauri/WebView support
  is added.

### MobilePagePresenter

Mobile UI presenter.

Responsibilities:

- Render current foreground page.
- Use `showPage(pageId)` to switch foreground page if background pages exist.
- Manage mobile memory policy.
- Report accurate surface visibility and active agent state.

## Shared Utilities To Extract

### Idle Close

Move duplicated idle-close behavior into shared code:

```txt
shared/page/idle-close.ts
```

The wrapper should:

- Touch pages on operations.
- Maintain `lastUsedAt` and `expiresAt`.
- Close only pages that still match the scheduled deadline.
- Close subscriptions and host resources on auto-close.

### CDP Subscription Manager

Move subscription buffering/polling into:

```txt
shared/page/cdp-subscription-manager.ts
```

Requirements:

- Buffer cap, currently 1000 events.
- Dropped event count.
- Max wait, currently 60 seconds.
- Single concurrent poll per subscription.
- Close/wake behavior on unsubscribe, page close, host disconnect, or debugger
  detach.

### JS Execution Wrapper

Extract one expression/body wrapper and timeout helper for page JS:

```txt
shared/page/page-js.ts
```

Use it from both Electron `executeJavaScript` and CDP `Runtime.evaluate`
paths. Error messages should use `runPageJs`, not old tab names.

### Input Normalization

Extract shared input normalization where Electron and CDP can share semantics:

```txt
shared/page/page-input.ts
```

Coordinate policy should be explicit: coordinates are CSS pixels relative to
the page viewport.

### Source Resolution

Add host-aware source resolution:

```txt
shared/page/page-source.ts
desktop/page/desktop-page-source.ts
server/page/daemon-page-source.ts
mobile/src/page/mobile-page-source.ts
```

This prevents agent-facing APIs from knowing whether a view is loaded through
desktop HTTPS interception, mobile `agentview://`, daemon HTTP, or a data URL.

## Proposed File Organization

```txt
shared/page/
  types.ts
  page-manager.ts
  page-host.ts
  page-handle.ts
  page-events.ts
  page-source.ts
  capabilities.ts
  idle-close.ts
  cdp-subscription-manager.ts
  page-js.ts
  page-input.ts

shared/runtime/functions/
  pages.ts

desktop/page/
  desktop-page-host.ts
  electron-page-handle.ts
  electron-headless-page-host.ts
  desktop-page-layout.ts
  desktop-tab-presenter.ts
  desktop-page-ipc.ts

server/page/
  daemon-headless-page-host.ts
  chrome-page-handle.ts
  remote-client-page-host.ts
  daemon-page-source.ts

mobile/src/page/
  mobile-page-host.ts
  mobile-page-presenter.ts
  iframe-page-handle.ts
```

Existing `TabViewManager` should be split, not expanded.

## Remote Protocol Changes

Replace generic client function RPC for pages with typed page RPC.

Server-to-client RPC methods:

```txt
client.pages.snapshot
client.pages.open
client.pages.close
client.pages.show
client.pages.reload
client.pages.capture
client.pages.runJs
client.pages.sendInput
client.pages.inspectElement
client.pages.getConsoleLogs
client.pages.sendCdp
client.pages.subscribeCdp
client.pages.pollCdp
client.pages.unsubscribeCdp
client.pages.detachCdp
```

Client-to-daemon page messages/events:

```txt
client:page-event
client:page-snapshot-changed
```

Those names are illustrative. The important protocol point is direction: these
are client-to-daemon notifications, not server-to-client RPCs. They likely need
new `WsMessage` variants or a dedicated backend RPC method instead of being
folded into `client.pages.*`, which is the server-to-client namespace.

Event payloads should cover:

```txt
created
updated
closed
currentChanged
lifecycleChanged
capabilitiesChanged
contentStaleChanged
```

Protocol capability shape should move from:

```ts
capabilities: {
  tabs: boolean
  clientFunctionProxy: boolean
}
```

to something page-aware, for example:

```ts
capabilities: {
  pages: {
    clientProxy: boolean
    headless: boolean
    connectedClientIds: string[]
  }
  clientFunctionProxy: boolean
}
```

Reconnect rules:

- When the client disconnects, daemon-mirrored client pages become
  `unavailable`.
- Pending page RPCs reject.
- Page CDP subscriptions owned by the disconnected client close.
- On reconnect, daemon requests `client.pages.snapshot`.
- Snapshot versioning resolves stale events.
- If a different client replaces the previous connection, old client-hosted
  pages remain unavailable unless the new client reports matching page IDs.

Current architecture effectively supports one connected client. The new types
should include `clientId` anyway so multi-client behavior does not require a
second redesign.

## Display And Routing Rules

### Local Desktop Agent

```txt
display: 'foreground' | 'background'
  -> DesktopPageHost + DesktopTabPresenter + DesktopPageLayout

display: 'headless'
  -> ElectronHeadlessPageHost initially
  -> optional true Chrome/CDP host later
```

### Remote Daemon Agent

```txt
display: 'headless'
  -> DaemonHeadlessPageHost

display: 'foreground' | 'background'
  -> RemoteClientPageHost
  -> connected desktop/mobile client PageHost
```

### Mobile Client

```txt
display: 'foreground'
  -> MobilePageHost, if source is supported

display: 'background'
  -> fail initially, or create suspended metadata in a later phase

display: 'headless'
  -> not supported on mobile client
```

### Current Page

`getCurrentPage()` resolves in this order:

1. Determine the relevant client/surface for this runtime call.
2. Confirm the client is connected and active for the agent, if required.
3. Return that surface's foreground page.
4. Return `null` if no page is selected or no suitable surface exists.

For scheduled/daemon-only tasks with no connected active client, `getCurrentPage()`
should return `null`.

## Edge Cases To Handle

### Client And Agent State

- No client connected: foreground/background open fails; headless may still
  work if configured.
- Connected client is not active for the agent: foreground open should fail or
  require an explicit "switch client to agent" operation. It should not
  silently steal the user's active agent.
- Inactive desktop agent: selected page may remain `display: 'foreground'` for
  its own surface but `presentation.visibleNow` is false with reason
  `inactive-agent`.
- Zen mode/app hidden: selected desktop page remains foreground but
  `visibleNow` is false with reason `collapsed` or `hidden-window`.
- Multiple future clients: current page is per client/surface, never global.

### Display Transitions

- `showPage(backgroundPage)` promotes it to foreground and demotes the previous
  foreground page on that surface to background.
- `showPage(foregroundPage)` is a no-op that still returns current `PageInfo`.
- `showPage(headlessPage)` fails.
- Closing a foreground page lets the presenter choose the next foreground page
  by local UI policy and emits `page.currentChanged`.
- Opening `background` on a host without background support fails.

### Page Lifecycle

- Operations on `opening` pages may either wait for ready or fail based on the
  operation. Capture, JS, input, inspect, and reload should wait with a bounded
  timeout.
- Operations on `failed` pages should fail except close/reload/show.
- Operations on `suspended` pages should fail unless the host can resume them.
  `showPage` may resume suspended pages.
- Operations on `unavailable` pages fail until a reconnect snapshot restores
  them.
- Operations on `crashed` pages fail except close/reload where supported.
- Closed page IDs are invalid.

### Source Updates

- View update: mark matching view pages `content.stale = true`; presenter can
  show a changed dot.
- View rename: update `source.name` if the DB change includes the old and new
  key, or mark old page failed/stale if it cannot be resolved.
- View delete: mark page failed or close it based on presenter policy. Mobile
  currently closes active deleted views.
- Reload clears `content.stale`.
- File source changes are harder to observe; initial implementation can leave
  them untracked unless file watching is added.

### Security And Isolation

- View/file pages should keep per-agent origin/session isolation.
- External URL pages should not get `window.agentwfy`.
- URL source validation must reject unsupported schemes before creating a page.
- File source validation must use existing path policy.
- Remote page RPCs must be authenticated by the existing agent token channel.
- Page IDs from clients must be scoped to the authenticated agent/client.
- CDP attach can fail if DevTools or another debugger is attached. Capability
  can still be true, but the operation must return a clear busy/attach error.

### Presenter Protection

- Presenter state such as desktop tab pinning should not live in `PageInfo`.
- If presenter state blocks a close, `closePage()` should fail with a clear
  `PageCloseBlocked`-style error instead of silently no-oping.
- It is not yet decided whether desktop pinned tabs should block agent-requested
  `closePage()` or only hide the UI close affordance.

### Screenshots And Fallback

- `capturePage` should not silently fallback to another host.
- If `allowFallback` is true, the result must include fallback metadata.
- Fallback rendering may not match cookies, storage, viewport, fonts, native
  platform rendering, or view runtime state.
- Desktop `WebContentsView.capturePage()` compositor workarounds stay inside
  desktop host/layout code.

### CDP

- `sendPageCdp` requires `capabilities.cdp`.
- Subscriptions close on page close, detach, crash, or host disconnect.
- Buffer overflow must report dropped counts.
- One concurrent poll/iteration per subscription.
- `detachPageCdp` should close all subscriptions for that page.

### Console Logs

- Keep a bounded buffer, currently 1000 entries.
- Normalize levels across Electron and CDP.
- Include timestamps.
- Decide later whether console logs should also be streamed as page events.

### Input

- Coordinates are CSS pixels relative to the page viewport.
- Validate keyboard events require `keyCode`.
- Normalize aliases such as `mousedown` to `mouseDown`.
- On mobile, input is unsupported until a native/synthetic strategy exists.

## Implementation Plan

Because backward compatibility is not required, the final state should be a
clean replacement. Temporary internal adapters are acceptable during
implementation if they reduce risk, but they should not survive as public
agent-facing APIs.

### Phase 0: Fix Daemon Headless View Runtime Invariant

Status as of 2026-05-31: **implemented and verified**.

Implemented in:

- `server/headless-view-runtime.ts`
- `server/headless-chrome.ts`
- `server/runtime-bootstrap.ts`

Verification performed:

- `./scripts/build-server`
- Fresh `./scripts/preview` from this worktree.
- Host-local `agentwfy-server` daemon with
  `AGENTWFY_BROWSER_EXECUTABLE=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- Preview app connected to that daemon as a remote agent.
- Daemon headless `view` page verified for:
  - `window.agentwfy` available before user scripts.
  - Real URL params via `location.search`.
  - `window.agentwfy.runSql(...)` bridge calls.
  - `/module/...` loading.
  - Root-relative file/asset loading through path-policy serving.
  - Screenshot capture.
  - Console log collection.
  - Close cleanup.
  - External URL isolation (`window.agentwfy` remains undefined).
  - View-authored `window.agentwfy.openTab({ viewName })` defaults to
    `headless: false`.

Testing note: the current daemon treats every WebSocket connection as the
single connected client. Direct daemon RPC smoke clients therefore replace the
preview client while connected. The Phase 0 smoke first verifies the preview
remote-agent connection, then disconnects that preview remote entry before
running direct daemon assertions with a synthetic client-function responder.
The typed page RPC work in later phases should avoid this generic-client
contention.

Fix the current daemon headless bug before the broader page rewrite, but build
the fix as daemon view-runtime infrastructure rather than tab-only glue.

Current bug:

- Daemon headless `view` and `file` sources are rendered in
  `server/headless-chrome.ts` as `data:` URLs.
- Those documents do not get `window.agentwfy`.
- They do not get normal view origin behavior.
- `/module/...`, `/file/...`, root-relative resources, and real query params do
  not behave like desktop/mobile view documents.

Required behavior:

- Every daemon headless AgentWFY view/file document exposes `window.agentwfy`
  before user scripts run.
- External URL headless tabs still do not receive `window.agentwfy`.
- View-authored calls such as `window.agentwfy.runSql(...)`,
  `window.agentwfy.read(...)`, plugin functions, events, tasks, and sessions
  route to the daemon runtime function registry.
- Client-proxied functions preserve existing clear "connected client required"
  errors when no client is connected.
- `window.agentwfy.openTab({ viewName })` should keep the current view-runtime
  default of `headless: false`; explicit `headless: true` should still work.

Recommended design:

- Stop loading daemon view/file headless tabs as `data:` URLs.
- Add daemon-served AgentWFY view URLs, for example:

```txt
http://127.0.0.1:<daemon-port>/agent/<agentId>/view/<viewName>?tabId=<pageId>&rev=<ts>&...
http://127.0.0.1:<daemon-port>/agent/<agentId>/file-view/<path>?tabId=<pageId>&rev=<ts>&...
```

- Inject a daemon-specific headless view host script into those documents.
- The script defines `window.agentwfy` as a Proxy, matching mobile's dynamic
  method behavior.
- Each bridge call posts JSON to a daemon runtime-call endpoint, for example:

```txt
POST /agent/<agentId>/headless/<pageId>/runtime-call
```

- The endpoint invokes the daemon-side `FunctionRegistry` for that agent.

Security requirements:

- Scope bridge calls by agent ID and page ID.
- Use the existing agent token or, preferably, a per-page random capability
  token embedded into the injected bridge script.
- Expire the token when the page closes or idle auto-closes.
- Keep file/module/view routes under the existing path policy.
- Do not expose Node, `require`, `process`, filesystem objects, or daemon
  process access to page JavaScript.
- CORS must not allow arbitrary origins to call the bridge endpoint.

Source loading requirements:

- View source: read HTML from the agent DB, inject shared view bootstrap and
  daemon bridge, serve from a normal daemon URL with real query params.
- File source: resolve through `assertPathAllowed`, read UTF-8 content, wrap it
  with `buildViewDocument()`, inject the same bridge, and serve with real query
  params.
- Module route: serve `/module/<name>` from the agent DB with the same content
  type behavior as desktop/mobile.
- File/assets: root-relative view resources should resolve through daemon file
  serving and path-policy checks. Decide whether `/asset/*` should serve
  bundled app assets for headless Chrome or return a clear 404; support it if
  system views need it.

Implementation steps:

1. [x] Add daemon HTTP routes for headless view documents, file-view documents,
   modules, and runtime-call bridge endpoint.
2. [x] Add daemon-specific bridge injection helper.
3. [x] Replace `htmlDataUrl(...)` for `viewName` and `filePath` in
   `server/headless-chrome.ts`.
4. [x] Remove `paramsBootstrapScript()` because params should be real URL params.
5. [x] Generate, store, validate, and clean up per-page bridge tokens.
6. [x] Verify bridge calls, modules, params, screenshots, external `execTabJs`,
   console logs, close behavior, and external URL isolation.

This phase should use neutral names such as `pageId`, `renderId`, or
`viewInstanceId` internally. The current tab API can pass the old `tabId` into
that field temporarily. The later page architecture should reuse this daemon
view-runtime infrastructure unchanged.

Goal: daemon headless view/file pages satisfy the AgentWFY view runtime
contract before the larger page migration starts.

### Phase 1: Confirm Policy Decisions

Status as of 2026-05-31: **implemented**.

Confirmed decisions:

- Low-level agent-facing `openPage()` requires explicit `display`.
  - Higher-level helpers may choose explicit defaults, such as
    `display: 'headless'` for automation helpers or `display: 'foreground'`
    for view/UI navigation helpers.
  - `PageManager` and host adapters must not invent implicit display defaults.
- Mobile background pages are out of scope for the first page implementation.
  - Mobile starts with one foreground view page.
  - `display: 'background'` on mobile must fail clearly until suspended
    background pages are explicitly implemented.
- Screenshot fallback is opt-in only.
  - `capturePage()` must not silently render through another host.
  - When `allowFallback: true` is used, the result must include fallback
    metadata identifying the actual captured page and fallback reason.
- Foreground open must not switch the active client agent in the first
  implementation.
  - Opening `display: 'foreground'` for a remote/client-hosted page must fail
    unless the target client is already active for that agent.
  - An explicit client-switch operation can be designed later if the workflow
    needs it.

Goal: remove ambiguity from the Page API contract before adding page types and
runtime functions in Phase 2.

### Phase 2: Define The Page Contract

Status as of 2026-05-31: **implemented and build-verified**.

Implemented in:

- `shared/page/types.ts`
- `shared/page/page-host.ts`
- `shared/page/page-handle.ts`
- `shared/page/page-manager.ts`
- `shared/page/legacy-tab-page-host.ts`
- `shared/runtime/functions/pages.ts`
- `shared/runtime/types.ts`
- `shared/runtime/daemon-functions.ts`

Notes:

- Runtime registration now exposes page functions instead of tab functions.
- The current tab runtime is still used behind a transitional
  `LegacyTabPageHost` adapter until the desktop/server hosts are split in
  later phases.
- Remote client generic function proxy keeps hidden tab handlers so the
  existing `TabRouter` can continue routing remote visible pages during the
  transition.
- `capturePage()` keeps the worker image auto-attachment behavior previously
  provided by `captureTab()`.
- `subscribePageCdp()` keeps the worker async-iterable behavior previously
  provided by `tabDebuggerSubscribe()`.

Verification performed:

- `./scripts/build`

- Add `shared/page/types.ts`.
- Add `PageInfo`, `PageSource`, `PageDisplay`, `PageLifecycle`,
  `PageCapabilities`, page event types, and screenshot/input/log/CDP types.
- Add `shared/page/page-host.ts` and `shared/page/page-handle.ts`.
- Add `shared/page/page-manager.ts`.
- Add `shared/runtime/functions/pages.ts`.
- Register page functions instead of tab functions.
- Update worker method types and daemon built-in function name lists.

Goal: establish the new vocabulary and prevent new runtime code from depending
on `TabApi`.

### Phase 3: Extract Shared Infrastructure

Status as of 2026-05-31: **implemented and build-verified**.

Implemented in:

- `shared/page/cdp-subscription-manager.ts`
- `shared/page/idle-close.ts`
- `shared/page/page-js.ts`
- `shared/page/page-input.ts`
- `shared/page/page-source.ts`
- `shared/page/capabilities.ts`

Notes:

- Desktop and daemon Chrome now share CDP subscription buffering/polling
  behavior, including buffer caps, dropped counts, max wait, concurrent-poll
  rejection, and close wakeups.
- Desktop headless tabs and daemon Chrome headless pages now use a shared
  idle-close scheduler for `lastUsedAt`, `expiresAt`, rescheduling, and
  auto-close error handling.
- Desktop `executeJavaScript` and daemon/CDP `Runtime.evaluate` paths now use
  one page JS wrapper and timeout helper, with `runPageJs` error wording.
- Electron and CDP input dispatch now share page input normalization for event
  aliases, coordinates, modifiers, buttons, click counts, and keyboard
  validation.
- Page source formatting/normalization helpers are shared by runtime page
  functions, `PageManager`, and the transitional legacy tab adapter.
- The transitional legacy tab adapter derives capability metadata from its
  `PageHandle` method surface.

Verification performed:

- `./scripts/build`

- Extract CDP subscription buffering/polling.
- Extract idle close.
- Extract page JS wrapping and timeout messages.
- Extract input normalization where shared semantics are possible.
- Extract source validation/resolution helpers.
- Make capabilities derive from actual `PageHandle` methods and host metadata.

Goal: reduce duplication before replacing concrete backends.

### Phase 4: Split Desktop TabViewManager

Status as of 2026-05-31: **implemented and build-verified**.

Implemented in:

- `desktop/page/desktop-page-types.ts`
- `desktop/page/desktop-page-layout.ts`
- `desktop/page/desktop-page-debugger.ts`
- `desktop/page/desktop-tab-presenter.ts`
- `desktop/page/desktop-page-host.ts`
- `desktop/page/electron-headless-page-host.ts`
- `desktop/tab-view-manager.ts`

Notes:

- `TabViewManager` remains the compatibility facade for existing desktop IPC,
  shortcuts, command palette calls, and transitional `TabApi` wiring.
- Layout responsibilities are isolated in `DesktopPageLayout`, including
  bounds sync, z-ordering, overlay preservation, active-agent collapse,
  zen-mode/window-hidden collapse, selected bounds tracking, and off-screen
  headless/capture placement constants.
- CDP attach/send/subscribe/poll/detach behavior is isolated in
  `DesktopPageDebugger`, backed by the shared `PageCdpSubscriptionManager`.
- Tab presenter state is isolated in `DesktopTabPresenter`, including selected
  tab state, pin/reorder state, changed indicators, keyboard tab switching, and
  renderer state pushes.
- `DesktopPageHost` and `ElectronHeadlessPageHost` define the desktop page host
  boundary for Phase 5 while preserving the existing tab-backed behavior.
- `openTabHandler` now accepts an optional internal `tabId` so page hosts can
  honor a `PageManager`-generated page ID in the next wiring phase.

Verification performed:

- `./scripts/build-desktop`

Split `desktop/tab-view-manager.ts` into:

- `DesktopPageHost`
- `ElectronHeadlessPageHost`
- `DesktopPageLayout`
- `DesktopTabPresenter`
- shared debugger subscription manager

Preserve current behavior during the split:

- WebContentsView bounds sync.
- Off-screen capture workaround.
- Active-agent collapse.
- Zen-mode collapse.
- Overlay z-order.
- `webContentsId` sender registration.
- View update changed indicators.
- Command-palette page/tab list.
- Keyboard shortcuts.
- Status-line headless indicator.
- Chat link and provider-settings navigation.

Goal: isolate UI tab presentation from page lifecycle.

### Phase 5: Wire Local Desktop Agents Through PageManager

Status as of 2026-05-31: **implemented and build-verified**.

Implemented in:

- `desktop/agent-context.ts`
- `desktop/agent-context-factory.ts`
- `desktop/page/desktop-page-host.ts`
- `desktop/ipc/pages.ts`
- `desktop/preload.cts`
- `desktop/renderer/ipc-types/pages.ts`
- `desktop/renderer/components/tabs.ts`
- `desktop/renderer/components/agent_chat.ts`
- `desktop/renderer/components/provider_grid.ts`
- `desktop/renderer/components/status_line.ts`
- `desktop/command-palette/manager.ts`
- `desktop/agent-orchestrator.ts`

Notes:

- Local desktop contexts now construct a `PageManager` with `DesktopPageHost`
  for foreground/background pages and `ElectronHeadlessPageHost` for headless
  pages, and pass it directly into local runtime function registration.
- `openPage({ display: 'background' })` now creates an unselected desktop tab
  without briefly showing it.
- Renderer lifecycle/navigation calls now use page-named IPC (`pages.openPage`,
  `pages.showPage`, `pages.closePage`, and `pages.getHeadlessCount`) while tab
  presenter state, bounds, reorder, pin, and context-menu IPC remain tab-named.
- Default view opening and command-palette view/tab actions now route through
  `PageApi`.

Verification performed:

- `./scripts/build-desktop`

- Construct `PageManager` per local desktop agent context.
- Register page functions in local runtime.
- Route foreground/background pages to desktop page host and presenter.
- Route headless pages to Electron headless host initially.
- Implement `getCurrentPage()` from presenter-owned foreground surface state.
- Implement `showPage()` as foreground transition.
- Update renderer IPC/preload names for runtime/page lifecycle operations.

Goal: make pages the internal runtime abstraction for local desktop agents.

### Phase 6: Add Typed Remote Page Protocol

Status as of 2026-06-01: **implemented and build-verified**.

Implemented in:

- `shared/backend/protocol.ts`
- `shared/backend/remote.ts`
- `shared/page/remote-client-page-host.ts`
- `shared/page/page-manager.ts`
- `shared/page/legacy-tab-page-host.ts`
- `server/client-bridge.ts`
- `server/runtime-bootstrap.ts`
- `server/index.ts`
- `desktop/agent-context-remote.ts`
- `desktop/agent-context-factory.ts`

Notes:

- Daemon user-facing pages now route through typed `client.pages.*` RPC
  methods instead of `client.functions.invoke`.
- The generic client function proxy is retained only for non-page UI functions
  such as palette actions, external URL opening, and plugin confirmations.
- The daemon runtime now builds an explicit `PageManager` with
  `RemoteClientPageHost` for foreground/background pages and keeps the legacy
  tab adapter limited to daemon headless pages until Phase 7.
- Client page snapshots resync on reconnect, and mirrored client pages are
  marked `unavailable` when the client disconnects.
- Remote foreground opens/show operations fail clearly when the connected
  desktop client is not active for the agent.
- `PageManager` can honor an internally supplied page ID so daemon-generated
  page IDs survive client-hosted page creation.

Verification performed:

- `./scripts/build`

- Extend `shared/backend/protocol.ts` for typed page RPC and events.
- Extend `ConnectedClientBridge` beyond generic function invocation.
- Add client-side page RPC dispatch in `RemoteBackend` or a page-specific
  companion.
- Replace remote visible-tab proxy through `client.functions.invoke`.
- Add snapshot/resync behavior on reconnect.
- Keep generic function proxy only for non-page UI functions such as palette
  and plugin confirmations.

Goal: make remote page behavior explicit and observable.

### Phase 7: Refactor Daemon Headless Chrome Into PageHost

Status as of 2026-06-01: **implemented and build-verified**.

Implemented in:

- `server/headless-chrome.ts`
- `server/runtime-bootstrap.ts`
- `shared/browser/cdp-ops.ts`
- `shared/page/idle-close.ts`

Notes:

- The daemon runtime now installs Chrome headless support as a direct
  `DaemonHeadlessPageHost` in `PageManager`; daemon headless pages no longer
  route through `TabRouter` or `LegacyTabPageHost`.
- `DaemonHeadlessPageHost` honors `PageManager`-assigned page IDs, owns Chrome
  target/session lifecycle, and exposes `PageInfo` with `daemon-headless`
  ownership, `headless` display, lifecycle state, idle metadata, and explicit
  capabilities.
- The Chrome page handle implements page-native capture, JS execution, input,
  inspection, console logs, CDP send/subscribe/poll/detach, reload, and close.
- CDP subscriptions and idle-close cleanup are closed from the host when pages
  close or idle-close.
- Daemon `view` and `file` headless pages continue to load through the Phase 0
  `HeadlessViewRuntime` URLs, preserving `window.agentwfy` injection and token
  cleanup.

Verification performed:

- `./scripts/build-server`
- `./scripts/build`

- Convert `HeadlessChromeBrowserHost` into `DaemonHeadlessPageHost`.
- Implement Chrome `PageHandle`.
- Use shared CDP subscriptions and idle close.
- Expose accurate capabilities.
- Do not preserve daemon data-URL view behavior as acceptable parity. Daemon
  headless view pages must expose `window.agentwfy` through the Phase 0 daemon
  view-runtime infrastructure.

Goal: unify daemon headless pages with the page model without overstating
capabilities.

### Phase 8: Add Mobile Page Support

- Replace `activeViewName`/`activeViewVersion` with page state.
- Implement `MobilePageHost` and `IframePageHandle`.
- Start with one foreground view page.
- Expose accurate capabilities.
- Make background open fail clearly until suspended background pages are
  implemented.
- Later add background page switcher and suspension/resume policy.

Goal: let mobile participate in the same page API while staying honest about
its actual capabilities.

### Phase 9: Remove Old Tab Runtime Types And Docs

- Remove `TabApi`, `VisibleTabHost`, `BrowserHost`, and `TabRouter` once
  replaced.
- Remove `TabData` as a shared runtime model.
- Replace system docs for tabs/debugger with page docs.
- Update system views using `window.agentwfy.openTab`.
- Update renderer chat links/provider settings/finder to use page APIs.
- Keep tab-specific UI state only in presenter modules.

Goal: finish the clean vocabulary break.

## Verification Checklist

Desktop local:

- Open foreground view/file/url page.
- Open background page without selecting it.
- Show background page.
- Close foreground page and verify next foreground selection.
- Open headless page, capture it, run JS, send input, and verify idle close.
- Verify inactive agent pages do not leak through.
- Verify zen mode/app hidden collapse does not re-expand views unexpectedly.
- Verify command palette, shortcuts, status line, chat links, provider settings,
  and system finder navigation still work.

Remote desktop client:

- Daemon headless page works with Chrome configured.
- Foreground/background page opens through typed client page RPC.
- `getCurrentPage()` returns the desktop client's selected page.
- Client disconnect marks client pages unavailable.
- Reconnect resyncs page snapshot.
- Pending page RPC rejects on disconnect.

Daemon headless:

- View/file/url source loading works.
- View/file pages expose `window.agentwfy` before user scripts run.
- Capabilities are accurate.
- CDP subscribe/poll/drop/close behavior matches desktop semantics.
- Idle close works.

Mobile:

- Foreground view page opens through page model.
- `getCurrentPage()` returns the active mobile page.
- Unsupported operations fail with capability errors.
- Background open fails clearly in first implementation.
- Agent switching clears or resyncs active page state correctly.

Docs/runtime:

- `getAvailableFunctions()` lists page functions only.
- Old tab functions are gone from agent-facing docs.
- `capturePage()` auto-attaches images in exec results.
- CDP async iterable behavior still works.

## Remaining Open Decisions

1. Should desktop pinned tabs block agent-requested `closePage()`?
   - Recommendation: decide explicitly. If pinning blocks close, return a clear
     blocked error. If pinning is only a UI affordance, allow `closePage()` to
     close pinned pages when the agent has the page ID.

## Summary

The current architecture worked when the app only had desktop-visible tabs. It
is now stretched across desktop visible tabs, desktop off-screen hidden views,
daemon headless Chrome, remote client-hosted pages, and mobile iframes.

The core change is to make **page** the runtime primitive and **tab** a UI
presentation detail. Pages have explicit source, display, lifecycle, owner, and
capabilities. Desktop can present user-facing pages as tabs. Mobile can present
one foreground page first and later add suspended background pages. The daemon
can host true headless pages through Chrome/CDP.

The most important modeling rule is:

```ts
type PageDisplay = 'foreground' | 'background' | 'headless'
```

with foreground scoped to a concrete client page surface, and actual physical
visibility reported separately.
