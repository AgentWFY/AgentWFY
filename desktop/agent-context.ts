import type { EventBus } from '#shared/event-bus.js';
import type { TabViewManager } from './tab-views/manager.js';
import type { TriggerEngine } from '#shared/triggers/engine.js';
import type { PluginRegistry } from '#shared/plugins/registry.js';
import type { ProviderRegistry } from '#shared/providers/registry.js';
import type { FunctionRegistry } from '#shared/runtime/function_registry.js';
import type { AgentSessionManager } from '#shared/agent/session_manager.js';
import type { TaskRunner } from '#shared/task-runner/task_runner.js';
import type { ShortcutManager } from './shortcuts/manager.js';
import type { JsRuntime } from '#shared/runtime/js_runtime.js';
import type { TabHost } from '#shared/runtime/hosts.js';
import type { AgentBackend } from '#shared/backend/interface.js';
import type { AgentChatPump } from './ipc/agent-sessions.js';
import type { RemoteAgentConfig } from './agent-meta.js';
import type { AgentChatController } from '#shared/agent/chat_controller.js';

interface AgentContextBase {
  /** Opaque, stable agent identity used by the sidebar/orchestrator/stores.
   *  Never a filesystem path. */
  agentId: string;
  /** Desktop-side per-agent working dir (DB mirror, tabs, system views).
   *  Always present. Equals runtimeRoot for local agents; a sandbox dir for remote ones. */
  cacheRoot: string;
  /** Renderer-side pub/sub. Real instance for both variants. */
  eventBus: EventBus;
  tabViewManager: TabViewManager;
  tabTools: TabHost;
  shortcutManager: ShortcutManager;
  /** The agent backend used by IPC and the renderer event pump. */
  backend: AgentBackend;
  /** Desktop chat-panel controller for this agent. */
  chat: AgentChatController;
  /** Renderer snapshot/streaming pump. One implementation for both backends —
   *  see setupAgentChatPump. Null between construction and pump setup. */
  chatPump: AgentChatPump | null;
  /** Disposer for the backend.events subscription wired by the orchestrator. */
  eventsUnsubscribe: (() => void) | null;
  dbChangeDebounceTimer: ReturnType<typeof setTimeout> | null;
  triggerReloadDebounceTimer: ReturnType<typeof setTimeout> | null;
  taskActionsReloadDebounceTimer: ReturnType<typeof setTimeout> | null;
  providerStatePushTimer: ReturnType<typeof setTimeout> | null;
}

/** Local agent: full runtime lives in this process. */
export interface LocalAgentContext extends AgentContextBase {
  mode: 'local';
  /** Filesystem root where the live runtime owns on-disk data (DB, plugin assets, sessions).
   *  Only present for local agents. Equals cacheRoot. */
  runtimeRoot: string;
  triggerEngine: TriggerEngine;
  pluginRegistry: PluginRegistry | null;
  providerRegistry: ProviderRegistry;
  functionRegistry: FunctionRegistry;
  sessionManager: AgentSessionManager;
  taskRunner: TaskRunner;
  jsRuntime: JsRuntime;
}

/** Remote agent: runtime lives on a daemon; desktop is a thin client. */
export interface RemoteAgentContext extends AgentContextBase {
  mode: 'remote';
  remoteConfig: RemoteAgentConfig;
  /** Disposer for the backend.status subscription wired by the orchestrator. */
  statusUnsubscribe: (() => void) | null;
}

export type AgentContext = LocalAgentContext | RemoteAgentContext;

export function isLocalAgentContext(ctx: AgentContext): ctx is LocalAgentContext {
  return ctx.mode === 'local';
}
