import { getConfigValue } from '../settings/config.js';
import { SHORTCUT_PREFIX } from '../system-config/keys.js';
import type { ActionRegistry } from './registry.js';

const IS_DARWIN = process.platform === 'darwin';

interface ParsedShortcut {
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  mod: boolean; // true when 'mod' was used (cross-platform: Cmd on macOS, Ctrl elsewhere)
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
    mod:   hasMod,
    key,
  };
}

function serializeCombo(meta: boolean, ctrl: boolean, shift: boolean, alt: boolean, key: string): string {
  return `${meta ? 1 : 0}:${ctrl ? 1 : 0}:${shift ? 1 : 0}:${alt ? 1 : 0}:${key.toLowerCase()}`;
}

function formatDisplay(parsed: ParsedShortcut): string {
  const segments: string[] = [];

  if (IS_DARWIN) {
    if (parsed.ctrl)  segments.push('⌃');
    if (parsed.alt)   segments.push('⌥');
    if (parsed.shift) segments.push('⇧');
    if (parsed.meta)  segments.push('⌘');
  } else {
    if (parsed.ctrl)  segments.push('Ctrl+');
    if (parsed.alt)   segments.push('Alt+');
    if (parsed.shift) segments.push('Shift+');
    if (parsed.meta)  segments.push('Meta+');
  }

  segments.push(parsed.key.toUpperCase());
  return segments.join('');
}

function toElectronAccelerator(parsed: ParsedShortcut): string {
  const segments: string[] = [];

  if (parsed.mod)        segments.push('CmdOrCtrl');
  else if (parsed.meta)  segments.push('Cmd');
  else if (parsed.ctrl)  segments.push('Ctrl');
  if (parsed.shift) segments.push('Shift');
  if (parsed.alt)   segments.push('Alt');

  // Electron expects uppercase first letter for single chars
  const k = parsed.key;
  segments.push(k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1));
  return segments.join('+');
}

export class ShortcutManager {
  // serialized combo → action ID
  private keyMap = new Map<string, string>();
  // action ID → parsed shortcut (for display/accelerator without re-parsing)
  private parsed = new Map<string, ParsedShortcut>();
  private readonly registry: ActionRegistry;

  constructor(agentRoot: string, registry: ActionRegistry) {
    this.registry = registry;
    this.reload(agentRoot);
  }

  reload(agentRoot: string): void {
    this.keyMap.clear();
    this.parsed.clear();

    for (const action of this.registry.getAllForAgent(agentRoot)) {
      const configKey = SHORTCUT_PREFIX + action.id;
      const raw = getConfigValue(agentRoot, configKey, action.defaultKey ?? DISABLED) as string;

      if (raw === DISABLED) continue;

      const parsed = parseShortcut(raw);
      if (!parsed) continue;

      this.parsed.set(action.id, parsed);
      const combo = serializeCombo(parsed.meta, parsed.ctrl, parsed.shift, parsed.alt, parsed.key);
      this.keyMap.set(combo, action.id);
    }
  }

  match(key: string, meta: boolean, ctrl: boolean, shift: boolean, alt: boolean): string | null {
    const combo = serializeCombo(meta, ctrl, shift, alt, key);
    return this.keyMap.get(combo) ?? null;
  }

  getDisplayShortcut(actionId: string): string | null {
    const parsed = this.parsed.get(actionId);
    if (!parsed) return null;
    return formatDisplay(parsed);
  }

  getElectronAccelerator(actionId: string): string | null {
    const parsed = this.parsed.get(actionId);
    if (!parsed) return null;
    return toElectronAccelerator(parsed);
  }
}
