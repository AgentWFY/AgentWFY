import type { WebContentsView } from 'electron';
import type { AgentContext } from '../agent-context.js';
import type { CommandPaletteManager } from '../command-palette/manager.js';
import type { RendererBridge } from '../renderer-bridge.js';
import type { TabViewManager } from '../tab-views/manager.js';
import type { ActionRegistry } from './registry.js';

export interface BuiltInActionDeps {
  getActiveAgentContext: () => AgentContext | null;
  getCommandPalette: () => CommandPaletteManager | null;
  getRendererBridge: () => RendererBridge | null;
  getRendererView: () => WebContentsView | null;
  getIsZenMode: () => boolean;
  toggleZenMode: () => void;
  switchToNextAgent: (direction: 1 | -1) => void;
}

export function registerBuiltInActions(registry: ActionRegistry, deps: BuiltInActionDeps): void {
  const requireActive = (): AgentContext | null => deps.getActiveAgentContext();

  // Zen mode hides the tab strip and substitutes a session-scoped surface in
  // the renderer, so the same shortcut switches/closes/cycles sessions there
  // instead of tabs.
  const tabAction = (zen: () => void, windowed: (mgr: TabViewManager) => void) => () => {
    const ctx = requireActive();
    if (!ctx) return;
    if (deps.getIsZenMode()) zen();
    else windowed(ctx.tabViewManager);
  };

  const cycleSession = (direction: 1 | -1) =>
    deps.getRendererBridge()?.dispatchRendererCustomEvent('agentwfy:cycle-session', { direction });

  registry.register({
    id: 'toggle-command-palette',
    label: 'Command Palette',
    defaultKey: 'mod+k',
    run: () => deps.getCommandPalette()?.toggle(),
  });

  registry.register({
    id: 'open-sessions-list',
    label: 'Open Sessions List',
    defaultKey: 'mod+shift+k',
    run: () => deps.getCommandPalette()?.show({ screen: 'sessions' }),
  });

  registry.register({
    id: 'open-tabs-list',
    label: 'Open Tabs List',
    defaultKey: 'mod+shift+p',
    run: () => deps.getCommandPalette()?.show({ screen: 'tabs' }),
  });

  registry.register({
    id: 'toggle-agent-chat',
    label: 'Toggle AI Panel',
    defaultKey: 'mod+i',
    run: () => deps.getRendererBridge()?.dispatchRendererWindowEvent('agentwfy:toggle-agent-chat'),
  });

  registry.register({
    id: 'toggle-task-panel',
    label: 'Toggle Task Panel',
    defaultKey: 'mod+j',
    run: () => deps.getRendererBridge()?.dispatchRendererWindowEvent('agentwfy:toggle-task-panel'),
  });

  registry.register({
    id: 'toggle-zen-mode',
    label: 'Zen Mode',
    defaultKey: 'mod+.',
    run: () => deps.toggleZenMode(),
  });

  registry.register({
    id: 'close-current-tab',
    label: 'Close Current Tab',
    defaultKey: 'mod+w',
    run: tabAction(
      () => deps.getRendererBridge()?.dispatchRendererWindowEvent('agentwfy:close-current-session'),
      (mgr) => mgr.closeCurrentTab(),
    ),
  });

  registry.register({
    id: 'reload-current-tab',
    label: 'Reload Current Tab',
    defaultKey: 'mod+r',
    run: () => requireActive()?.tabViewManager.reloadCurrentTab(),
  });

  registry.register({
    id: 'reload-window',
    label: 'Reload Window',
    defaultKey: 'mod+shift+r',
    run: () => deps.getRendererView()?.webContents.reload(),
  });

  registry.register({
    id: 'add-agent',
    label: 'Add Agent',
    defaultKey: 'mod+o',
    run: () => deps.getCommandPalette()?.runAction({ type: 'add-agent' }).catch(() => {}),
  });

  registry.register({
    id: 'new-session',
    label: 'New Session',
    defaultKey: 'mod+t',
    run: () => {
      const ctx = requireActive();
      if (!ctx) return;
      deps.getRendererBridge()?.dispatchRendererCustomEvent('agentwfy:open-sidebar-panel', { panel: 'agent-chat' });
      if (!ctx.sessionManager.activeIsEmpty) {
        ctx.sessionManager.newSession().catch(() => {});
      }
      // Explicit focus needed when chat panel is already open
      deps.getRendererBridge()?.dispatchRendererWindowEvent('agentwfy:focus-chat-input');
    },
  });

  registry.register({
    id: 'next-agent',
    label: 'Next Agent',
    defaultKey: 'ctrl+tab',
    run: () => deps.switchToNextAgent(1),
  });

  registry.register({
    id: 'previous-agent',
    label: 'Previous Agent',
    defaultKey: 'ctrl+shift+tab',
    run: () => deps.switchToNextAgent(-1),
  });

  registry.register({
    id: 'search-views',
    label: 'Search Views',
    defaultKey: 'mod+p',
    run: () => deps.getCommandPalette()?.showFiltered('views '),
  });

  registry.register({
    id: 'open-settings',
    label: 'Open Settings',
    defaultKey: 'mod+,',
    run: () => deps.getCommandPalette()?.show({ screen: 'settings' }),
  });

  registry.register({
    id: 'toggle-dev-tools',
    label: 'Toggle Developer Tools',
    defaultKey: 'alt+mod+i',
    run: () => deps.getRendererView()?.webContents.toggleDevTools(),
  });

  registry.register({
    id: 'previous-tab',
    label: 'Previous Tab',
    defaultKey: 'mod+shift+[',
    run: tabAction(() => cycleSession(-1), (mgr) => mgr.previousTab()),
  });

  registry.register({
    id: 'next-tab',
    label: 'Next Tab',
    defaultKey: 'mod+shift+]',
    run: tabAction(() => cycleSession(1), (mgr) => mgr.nextTab()),
  });

  for (let i = 1; i <= 9; i++) {
    const index = i - 1;
    registry.register({
      id: `switch-to-tab-${i}`,
      label: `Switch to Tab ${i}`,
      defaultKey: `mod+${i}`,
      run: tabAction(
        () => deps.getRendererBridge()?.dispatchRendererCustomEvent('agentwfy:switch-to-session', { index }),
        (mgr) => mgr.switchToTabByIndex(index),
      ),
    });
  }
}
