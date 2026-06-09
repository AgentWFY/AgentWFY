import { createClientFunctionRegistry } from '#shared/runtime/client-function-registry.js'
import { createMobilePluginConfirmationHost } from './plugin-confirmation.js'

export function createMobileClientFunctionRegistry() {
  return createClientFunctionRegistry({
    getPluginConfirmationHost: createMobilePluginConfirmationHost,
  })
}
