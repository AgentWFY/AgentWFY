import { ipcMain, Menu, type BaseWindow, type MenuItemConstructorOptions } from 'electron';
import { showInstallAgentFromFileDialog, showOpenAgentDialog } from '../agent-manager.js';
import type { InstalledAgent } from './schema.js';
import { Channels } from './channels.cjs';

interface AgentSidebarHandlerDeps {
  getMainWindow: () => BaseWindow | null;
  getInstalledAgentsList: () => InstalledAgent[];
  addAgent: (agentId: string) => Promise<unknown> | unknown;
  switchAgent: (agentId: string) => Promise<unknown> | unknown;
  removeAgent: (agentId: string) => Promise<unknown> | unknown;
  stopAgent: (agentId: string) => Promise<unknown> | unknown;
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

  ipcMain.handle(Channels.agentSidebar.stop, async (_event, agentId: string) => {
    await deps.stopAgent(agentId);
  });

  ipcMain.handle(Channels.agentSidebar.reorder, async (_event, fromIndex: number, toIndex: number) => {
    deps.reorderAgents(fromIndex, toIndex);
  });

  ipcMain.handle(Channels.agentSidebar.showContextMenu, async (_event, agentId: string) => {
    const win = deps.getMainWindow();
    if (!win || win.isDestroyed()) return;

    const agents = deps.getInstalledAgentsList();
    const target = agents.find(a => a.agentId === agentId);
    const canRemove = agents.length > 1;
    // Active-agent stop requires another agent to fall back to.
    const canStop = !!target?.initialized && (!target.active || agents.length > 1);
    const template: MenuItemConstructorOptions[] = [];

    if (canStop) {
      const label = target!.backend === 'remote' ? 'Disconnect' : 'Stop Agent';
      template.push({
        label,
        click: () => {
          void deps.stopAgent(agentId);
        },
      });
    }

    if (canRemove) {
      if (template.length > 0) template.push({ type: 'separator' });
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
