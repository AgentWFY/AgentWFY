import { DesktopPageHost } from './desktop-page-host.js';
import type { TabViewManager } from '../tab-view-manager.js';

export class ElectronHeadlessPageHost extends DesktopPageHost {
  constructor(manager: TabViewManager, options: { agentId: string }) {
    super(manager, {
      agentId: options.agentId,
      hostKind: 'desktop-headless',
      headless: true,
    });
  }
}
