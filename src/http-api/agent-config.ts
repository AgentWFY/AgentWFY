import path from 'path';
import fs from 'fs';
import { getAgentDir } from '../agent-manager.js';

const DEFAULT_PORT = 9877;

function configPath(agentRoot: string): string {
  return path.join(getAgentDir(agentRoot), 'config.json');
}

function readConfig(agentRoot: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(configPath(agentRoot), 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(agentRoot: string, config: Record<string, unknown>): void {
  fs.writeFileSync(configPath(agentRoot), JSON.stringify(config, null, 2), 'utf-8');
}

export function readAgentHttpPort(agentRoot: string): number {
  const port = getAgentConfigValue(agentRoot, 'httpApi.port');
  if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) {
    return port;
  }
  return DEFAULT_PORT;
}

function resolveKey(config: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = config;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function getAgentConfigValue(agentRoot: string, key: string): unknown {
  return resolveKey(readConfig(agentRoot), key);
}

export function getAgentConfigValues(agentRoot: string, keys: string[]): Map<string, unknown> {
  const config = readConfig(agentRoot);
  const result = new Map<string, unknown>();
  for (const key of keys) {
    result.set(key, resolveKey(config, key));
  }
  return result;
}

export function setAgentConfigValue(agentRoot: string, key: string, value: unknown): void {
  const config = readConfig(agentRoot);
  const parts = key.split('.');
  let current: Record<string, unknown> = config;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] == null || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
  writeConfig(agentRoot, config);
}
