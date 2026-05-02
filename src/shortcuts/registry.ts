export interface ActionDef {
  id: string;
  label: string;
  defaultKey?: string;
  run: () => void | Promise<void>;
}

export class ActionRegistry {
  private global = new Map<string, ActionDef>();
  private perAgent = new Map<string, Map<string, ActionDef>>();

  register(def: ActionDef): void {
    this.global.set(def.id, def);
  }

  registerForAgent(agentRoot: string, def: ActionDef): void {
    let bucket = this.perAgent.get(agentRoot);
    if (!bucket) {
      bucket = new Map();
      this.perAgent.set(agentRoot, bucket);
    }
    bucket.set(def.id, def);
  }

  unregisterForAgent(agentRoot: string, id: string): void {
    this.perAgent.get(agentRoot)?.delete(id);
  }

  clearAgent(agentRoot: string): void {
    this.perAgent.delete(agentRoot);
  }

  resolve(agentRoot: string | null, id: string): ActionDef | undefined {
    if (agentRoot) {
      const fromAgent = this.perAgent.get(agentRoot)?.get(id);
      if (fromAgent) return fromAgent;
    }
    return this.global.get(id);
  }

  getAllForAgent(agentRoot: string): ActionDef[] {
    const merged = new Map<string, ActionDef>();
    for (const def of this.global.values()) merged.set(def.id, def);
    const bucket = this.perAgent.get(agentRoot);
    if (bucket) {
      for (const def of bucket.values()) merged.set(def.id, def);
    }
    return Array.from(merged.values());
  }

  getAgentBucketActions(agentRoot: string): ActionDef[] {
    const bucket = this.perAgent.get(agentRoot);
    return bucket ? Array.from(bucket.values()) : [];
  }

  run(agentRoot: string | null, id: string): void {
    const def = this.resolve(agentRoot, id);
    if (!def) return;
    Promise.resolve()
      .then(() => def.run())
      .catch((err) => console.error(`[shortcuts] action "${id}" failed:`, err));
  }
}
