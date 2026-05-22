export interface ActionDef {
  id: string;
  label: string;
  defaultKey?: string;
  configKey?: string;
  run: () => void | Promise<void>;
}

export class ActionRegistry {
  private global = new Map<string, ActionDef>();
  private perAgent = new Map<string, Map<string, ActionDef>>();

  register(def: ActionDef): void {
    this.global.set(def.id, def);
  }

  registerForAgent(agentId: string, def: ActionDef): void {
    let bucket = this.perAgent.get(agentId);
    if (!bucket) {
      bucket = new Map();
      this.perAgent.set(agentId, bucket);
    }
    bucket.set(def.id, def);
  }

  unregisterForAgent(agentId: string, id: string): void {
    this.perAgent.get(agentId)?.delete(id);
  }

  clearAgent(agentId: string): void {
    this.perAgent.delete(agentId);
  }

  resolve(agentId: string | null, id: string): ActionDef | undefined {
    if (agentId) {
      const fromAgent = this.perAgent.get(agentId)?.get(id);
      if (fromAgent) return fromAgent;
    }
    return this.global.get(id);
  }

  getAllForAgent(agentId: string): ActionDef[] {
    const merged = new Map<string, ActionDef>();
    for (const def of this.global.values()) merged.set(def.id, def);
    const bucket = this.perAgent.get(agentId);
    if (bucket) {
      for (const def of bucket.values()) merged.set(def.id, def);
    }
    return Array.from(merged.values());
  }

  getAgentBucketActions(agentId: string): ActionDef[] {
    const bucket = this.perAgent.get(agentId);
    return bucket ? Array.from(bucket.values()) : [];
  }

  run(agentId: string | null, id: string): void {
    const def = this.resolve(agentId, id);
    if (!def) return;
    Promise.resolve()
      .then(() => def.run())
      .catch((err) => console.error(`[shortcuts] action "${id}" failed:`, err));
  }
}
