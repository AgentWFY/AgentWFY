import { contextBridge, ipcRenderer } from 'electron';

type CommandPaletteAction =
  | {
    type: 'open-view'
    viewId: string
    title: string
    viewUpdatedAt: number | null
  }
  | {
    type: 'toggle-agent-chat'
  }
  | {
    type: 'close-current-tab'
  }
  | {
    type: 'reload-views'
  };

interface CommandPaletteItem {
  id: string
  title: string
  subtitle?: string
  group: 'Views' | 'Actions'
  action: CommandPaletteAction
}

const COMMAND_PALETTE_CHANNEL = {
  CLOSE: 'agentwfy:command-palette:close',
  LIST_ITEMS: 'agentwfy:command-palette:list-items',
  RUN_ACTION: 'agentwfy:command-palette:run-action',
  OPENED: 'agentwfy:command-palette:opened',
} as const;

contextBridge.exposeInMainWorld('commandPaletteBridge', {
  listItems(): Promise<CommandPaletteItem[]> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.LIST_ITEMS);
  },
  runAction(action: CommandPaletteAction): Promise<void> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.RUN_ACTION, action);
  },
  close(): Promise<void> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.CLOSE);
  },
  onOpened(callback: () => void): () => void {
    const handler = () => callback();
    ipcRenderer.on(COMMAND_PALETTE_CHANNEL.OPENED, handler);
    return () => ipcRenderer.removeListener(COMMAND_PALETTE_CHANNEL.OPENED, handler);
  },
});
