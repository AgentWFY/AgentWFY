import type { BrowserWindow } from 'electron'
import type { OnDbChange } from '../../db/sqlite.js'
import type { AgentTabTools } from '../../ipc/tabs.js'
import type { AgentSessionManager } from '../../agent/session_manager.js'
import type { TaskRunner } from '../../task-runner/task_runner.js'
import type { FunctionRegistry } from '../function_registry.js'
import { registerFileOps } from './file_ops.js'
import { registerSql } from './sql.js'
import { registerTabs } from './tabs.js'
import { registerEvents } from './events.js'
import { registerAgent } from './agent.js'
import { registerTasks } from './tasks.js'

export interface BuiltInFunctionDeps {
  agentRoot: string
  win: BrowserWindow
  tabTools: AgentTabTools
  onDbChange?: OnDbChange
  getSessionManager: () => AgentSessionManager
  getTaskRunner: () => TaskRunner
}

export function registerAllBuiltInFunctions(registry: FunctionRegistry, deps: BuiltInFunctionDeps): void {
  registerFileOps(registry, { agentRoot: deps.agentRoot })
  registerSql(registry, { agentRoot: deps.agentRoot, onDbChange: deps.onDbChange })
  registerTabs(registry, { tabTools: deps.tabTools })
  registerEvents(registry, { win: deps.win })
  registerAgent(registry, { getSessionManager: deps.getSessionManager })
  registerTasks(registry, { getTaskRunner: deps.getTaskRunner })
}
