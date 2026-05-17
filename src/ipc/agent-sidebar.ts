import { ipcMain, Menu, type BaseWindow, type MenuItemConstructorOptions } from 'electron';
import { showInstallAgentFromFileDialog, showOpenAgentDialog } from '../agent-manager.js';
import { Channels } from './channels.cjs';

interface AgentSidebarHandlerDeps {
  getMainWindow: () => BaseWindow | null;
  getInstalledAgentsList: () => unknown[];
  addAgent: (agentId: string) => Promise<unknown> | unknown;
  switchAgent: (agentId: string) => Promise<unknown> | unknown;
  removeAgent: (agentId: string) => Promise<unknown> | unknown;
  reorderAgents: (fromIndex: number, toIndex: number) => void;
}

export function registerAgentSidebarHandlers(deps: AgentSidebarHandlerDeps): void {
  ipcMain.handle(Channels.agentSidebar.getInstalled, () => {
    return deps.getInstalledAgentsList();
  });

  ipcMain.handle(Channels.agentSidebar.switch, async (_event, agentId: string) => {
    await deps.switchAgent(agentId);
  });

  ipcMain.handle(Channels.agentSidebar.add, async () => {
    const picked = await showOpenAgentDialog(deps.getMainWindow());
    if (!picked) return null;
    await deps.addAgent(picked);
    return picked;
  });

  ipcMain.handle(Channels.agentSidebar.addFromFile, async () => {
    const picked = await showInstallAgentFromFileDialog(deps.getMainWindow());
    if (!picked) return null;
    await deps.addAgent(picked);
    return picked;
  });

  ipcMain.handle(Channels.agentSidebar.remove, async (_event, agentId: string) => {
    await deps.removeAgent(agentId);
  });

  ipcMain.handle(Channels.agentSidebar.reorder, async (_event, fromIndex: number, toIndex: number) => {
    deps.reorderAgents(fromIndex, toIndex);
  });

  ipcMain.handle(Channels.agentSidebar.showContextMenu, async (_event, agentId: string) => {
    const win = deps.getMainWindow();
    if (!win || win.isDestroyed()) return;

    const canRemove = deps.getInstalledAgentsList().length > 1;
    const template: MenuItemConstructorOptions[] = [];

    if (canRemove) {
      template.push({
        label: 'Close Agent',
        click: () => {
          void deps.removeAgent(agentId);
        },
      });
    }

    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}
