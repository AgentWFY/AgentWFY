import type { EventBus } from './event-bus.js';
import type { TabViewManager } from './tab-views/manager.js';
import type { TriggerEngine } from './triggers/engine.js';
import type { PluginRegistry } from './plugins/registry.js';
import type { ProviderRegistry } from './providers/registry.js';
import type { FunctionRegistry } from './runtime/function_registry.js';
import type { AgentSessionManager } from './agent/session_manager.js';
import type { TaskRunner } from './task-runner/task_runner.js';
import type { ShortcutManager } from './shortcuts/manager.js';
import type { JsRuntime } from './runtime/js_runtime.js';
import type { AgentTabTools } from './ipc/tabs.js';

/** Per-agent context (everything that is agent-specific). */
export interface AgentContext {
  agentRoot: string;
  eventBus: EventBus;
  tabViewManager: TabViewManager;
  triggerEngine: TriggerEngine;
  pluginRegistry: PluginRegistry | null;
  providerRegistry: ProviderRegistry;
  functionRegistry: FunctionRegistry;
  sessionManager: AgentSessionManager;
  taskRunner: TaskRunner;
  jsRuntime: JsRuntime;
  shortcutManager: ShortcutManager;
  agentStateStreamingCleanup: (() => void) | null;
  dbChangeDebounceTimer: ReturnType<typeof setTimeout> | null;
  triggerReloadDebounceTimer: ReturnType<typeof setTimeout> | null;
  taskActionsReloadDebounceTimer: ReturnType<typeof setTimeout> | null;
  tabTools: AgentTabTools;
}
