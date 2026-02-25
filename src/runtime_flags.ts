import type ElectronStore from 'electron-store';

function parseBooleanFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export type AgentRuntimeFlagSource = 'env' | 'store' | 'default';

export interface AgentRuntimeFlags {
  agentRuntimeV2: boolean;
  source: AgentRuntimeFlagSource;
}

export function resolveAgentRuntimeFlags(store: ElectronStore): AgentRuntimeFlags {
  const envValue = process.env.AGENT_RUNTIME_V2 ?? process.env.VITE_AGENT_RUNTIME_V2;
  if (typeof envValue !== 'undefined') {
    return { agentRuntimeV2: parseBooleanFlag(envValue), source: 'env' };
  }

  const storedValue = store.get('agentRuntimeV2');
  if (typeof storedValue !== 'undefined') {
    return { agentRuntimeV2: parseBooleanFlag(storedValue), source: 'store' };
  }

  return { agentRuntimeV2: false, source: 'default' };
}
