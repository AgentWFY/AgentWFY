import { getConfigValue } from '../settings/config.js';
import { SHORTCUT_ACTIONS, SHORTCUT_CONFIG_PREFIX } from './actions.js';

const IS_DARWIN = process.platform === 'darwin';

interface ParsedShortcut {
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

const DISABLED = 'disabled';

function parseShortcut(str: string): ParsedShortcut | null {
  if (!str || str === DISABLED) return null;

  const parts = str.toLowerCase().split('+');
  const key = parts.pop();
  if (!key) return null;

  const mods = new Set(parts);
  const hasMod = mods.has('mod');

  return {
    meta:  mods.has('cmd') || mods.has('meta') || (hasMod && IS_DARWIN),
    ctrl:  mods.has('ctrl') || (hasMod && !IS_DARWIN),
    shift: mods.has('shift'),
    alt:   mods.has('alt'),
    key,
  };
}

function serializeCombo(meta: boolean, ctrl: boolean, shift: boolean, alt: boolean, key: string): string {
  return `${meta ? 1 : 0}:${ctrl ? 1 : 0}:${shift ? 1 : 0}:${alt ? 1 : 0}:${key.toLowerCase()}`;
}

function formatDisplay(str: string): string | null {
  if (!str || str === DISABLED) return null;

  const parts = str.toLowerCase().split('+');
  const key = parts.pop();
  if (!key) return null;

  const mods = new Set(parts);
  const hasMod = mods.has('mod');
  const segments: string[] = [];

  if (IS_DARWIN) {
    if (mods.has('ctrl'))                        segments.push('⌃');
    if (mods.has('alt'))                         segments.push('⌥');
    if (mods.has('shift'))                       segments.push('⇧');
    if (mods.has('cmd') || mods.has('meta') || hasMod) segments.push('⌘');
  } else {
    if (mods.has('ctrl') || hasMod) segments.push('Ctrl+');
    if (mods.has('alt'))            segments.push('Alt+');
    if (mods.has('shift'))          segments.push('Shift+');
    if (mods.has('cmd') || mods.has('meta')) segments.push('Meta+');
  }

  segments.push(key.toUpperCase());
  return segments.join('');
}

function toElectronAccelerator(str: string): string | null {
  if (!str || str === DISABLED) return null;

  const parts = str.toLowerCase().split('+');
  const key = parts.pop();
  if (!key) return null;

  const mods = new Set(parts);
  const hasMod = mods.has('mod');
  const segments: string[] = [];

  if (hasMod)            segments.push('CmdOrCtrl');
  if (mods.has('cmd') || mods.has('meta')) segments.push('Cmd');
  if (mods.has('ctrl'))  segments.push('Ctrl');
  if (mods.has('shift')) segments.push('Shift');
  if (mods.has('alt'))   segments.push('Alt');

  // Electron expects uppercase first letter for single chars
  segments.push(key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
  return segments.join('+');
}

export class ShortcutManager {
  // serialized combo → action ID
  private keyMap = new Map<string, string>();
  // action ID → raw shortcut string (resolved from config or default)
  private resolved = new Map<string, string>();

  constructor(agentRoot: string) {
    this.reload(agentRoot);
  }

  reload(agentRoot: string): void {
    this.keyMap.clear();
    this.resolved.clear();

    for (const [actionId, action] of Object.entries(SHORTCUT_ACTIONS)) {
      const configKey = SHORTCUT_CONFIG_PREFIX + actionId;
      const raw = getConfigValue(agentRoot, configKey, action.defaultKey) as string;

      this.resolved.set(actionId, raw);

      if (raw === DISABLED) continue;

      const parsed = parseShortcut(raw);
      if (!parsed) continue;

      const combo = serializeCombo(parsed.meta, parsed.ctrl, parsed.shift, parsed.alt, parsed.key);
      this.keyMap.set(combo, actionId);
    }
  }

  match(key: string, meta: boolean, ctrl: boolean, shift: boolean, alt: boolean): string | null {
    const combo = serializeCombo(meta, ctrl, shift, alt, key);
    return this.keyMap.get(combo) ?? null;
  }

  getDisplayShortcut(actionId: string): string | null {
    const raw = this.resolved.get(actionId);
    if (!raw) return null;
    return formatDisplay(raw);
  }

  getElectronAccelerator(actionId: string): string | null {
    const raw = this.resolved.get(actionId);
    if (!raw) return null;
    return toElectronAccelerator(raw);
  }
}
