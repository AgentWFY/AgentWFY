import type { FunctionRegistry } from './function_registry.js'

export interface ClientFunctionInvoker {
  invokeClientFunction(name: string, params: unknown): Promise<unknown>
}

export const CLIENT_RUNTIME_FUNCTIONS = [
  'requestInstallPlugin',
  'requestTogglePlugin',
  'requestUninstallPlugin',
  'pickFromPalette',
  'openExternal',
] as const

const CLIENT_RUNTIME_FUNCTION_SET = new Set<string>(CLIENT_RUNTIME_FUNCTIONS)

export function isClientRuntimeFunction(name: string): boolean {
  return CLIENT_RUNTIME_FUNCTION_SET.has(name)
}

export function registerClientFunctionProxies(
  registry: FunctionRegistry,
  invoker: ClientFunctionInvoker,
): void {
  for (const name of CLIENT_RUNTIME_FUNCTIONS) {
    if (registry.has(name)) continue
    registry.register(
      name,
      (params) => invoker.invokeClientFunction(name, params),
      'connected-client',
    )
  }
}
