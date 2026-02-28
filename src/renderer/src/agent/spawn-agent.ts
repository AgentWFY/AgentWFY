type SpawnHandler = (prompt: string) => Promise<{ agentId: string }>

let handler: SpawnHandler | null = null

export function registerSpawnHandler(fn: SpawnHandler): () => void {
  handler = fn
  return () => {
    if (handler === fn) handler = null
  }
}

export async function spawnAgent(prompt: string): Promise<{ agentId: string }> {
  if (!handler) {
    throw new Error('No spawn handler registered. AgentSessionManager must be initialized first.')
  }
  return handler(prompt)
}
