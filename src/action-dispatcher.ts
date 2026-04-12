import type { WebContentsView } from 'electron';
import type { AgentContext } from './agent-context.js';
import type { CommandPaletteManager } from './command-palette/manager.js';
import type { RendererBridge } from './renderer-bridge.js';

export interface ActionDispatcherDeps {
  getActiveAgentContext: () => AgentContext | null;
  getCommandPalette: () => CommandPaletteManager | null;
  getRendererBridge: () => RendererBridge | null;
  getRendererView: () => WebContentsView | null;
  getIsZenMode: () => boolean;
  toggleZenMode: () => void;
  switchToNextAgent: (direction: 1 | -1) => void;
}

export class ActionDispatcher {
  private readonly deps: ActionDispatcherDeps;

  constructor(deps: ActionDispatcherDeps) {
    this.deps = deps;
  }

  handleShortcutAction(action: string): void {
    const activeCtx = this.deps.getActiveAgentContext();
    if (!activeCtx) return;

    switch (action) {
      case 'toggle-command-palette':
        this.deps.getCommandPalette()?.toggle();
        break;
      case 'toggle-agent-chat':
        this.deps.getRendererBridge()?.dispatchRendererWindowEvent('agentwfy:toggle-agent-chat');
        break;
      case 'toggle-task-panel':
        this.deps.getRendererBridge()?.dispatchRendererWindowEvent('agentwfy:toggle-task-panel');
        break;
      case 'toggle-agent-sidebar':
        this.deps.getRendererBridge()?.dispatchRendererWindowEvent('agentwfy:toggle-agent-sidebar');
        break;
      case 'toggle-zen-mode':
        this.deps.toggleZenMode();
        break;
      case 'close-current-tab':
        if (this.deps.getIsZenMode()) {
          this.deps.getRendererBridge()?.dispatchRendererWindowEvent('agentwfy:close-current-session');
        } else {
          activeCtx.tabViewManager.closeCurrentTab();
        }
        break;
      case 'reload-current-tab':
        activeCtx.tabViewManager.reloadCurrentTab();
        break;
      case 'reload-window':
        this.deps.getRendererView()?.webContents.reload();
        break;
      case 'add-agent':
        this.deps.getCommandPalette()?.runAction({ type: 'add-agent' }).catch(() => {});
        break;
      case 'new-session':
        this.handleNewSession(activeCtx);
        break;
      case 'next-agent':
        this.deps.switchToNextAgent(1);
        break;
      case 'previous-agent':
        this.deps.switchToNextAgent(-1);
        break;
      case 'search-views':
        this.deps.getCommandPalette()?.showFiltered('views ');
        break;
      case 'open-settings':
        this.deps.getCommandPalette()?.show({ screen: 'settings' });
        break;
      case 'toggle-dev-tools':
        this.deps.getRendererView()?.webContents.toggleDevTools();
        break;
      default:
        if (action.startsWith('switch-to-tab-')) {
          const index = parseInt(action.slice(-1), 10) - 1;
          if (this.deps.getIsZenMode()) {
            this.deps.getRendererBridge()?.dispatchRendererCustomEvent('agentwfy:switch-to-session', { index });
          } else {
            activeCtx.tabViewManager.switchToTabByIndex(index);
          }
        } else if (action === 'previous-tab') {
          if (this.deps.getIsZenMode()) this.deps.getRendererBridge()?.dispatchRendererCustomEvent('agentwfy:cycle-session', { direction: -1 });
          else activeCtx.tabViewManager.previousTab();
        } else if (action === 'next-tab') {
          if (this.deps.getIsZenMode()) this.deps.getRendererBridge()?.dispatchRendererCustomEvent('agentwfy:cycle-session', { direction: 1 });
          else activeCtx.tabViewManager.nextTab();
        }
        break;
    }
  }

  private handleNewSession(ctx: AgentContext): void {
    this.deps.getRendererBridge()?.dispatchRendererCustomEvent('agentwfy:open-sidebar-panel', { panel: 'agent-chat' });
    if (!ctx.sessionManager.activeIsEmpty) {
      ctx.sessionManager.newSession().catch(() => {});
    }
    // Explicit focus needed when chat panel is already open
    this.deps.getRendererBridge()?.dispatchRendererWindowEvent('agentwfy:focus-chat-input');
  }
}
