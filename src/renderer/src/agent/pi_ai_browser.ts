/**
 * Browser-only shim for `@mariozechner/pi-ai`.
 *
 * Why this exists:
 * - `@mariozechner/pi-agent-core` imports `@mariozechner/pi-ai` top-level.
 * - The top-level `pi-ai` entry re-exports all built-in providers, including
 *   Bedrock/AWS providers that pull Node-only dependencies.
 * - In this Vite renderer build, that causes production build failures such as:
 *   "Readable is not exported by __vite-browser-external"
 *   (from @smithy/node-http-handler / stream).
 *
 * This shim exports only the browser-safe pieces used by this app and wires
 * `stream`/`streamSimple` to OpenAI-compatible providers.
 *
 * Removal criteria:
 * - Remove this file + the alias in `vite.config.js` once our toolchain and
 *   upstream packages can build the renderer without pulling Node-only providers.
 */
import { Type } from '@sinclair/typebox'
import { getModel, getModels, getProviders, calculateCost, supportsXhigh, modelsAreEqual } from '@mariozechner/pi-ai/dist/models.js'
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from '@mariozechner/pi-ai/dist/providers/openai-completions.js'
import { streamOpenAIResponses, streamSimpleOpenAIResponses } from '@mariozechner/pi-ai/dist/providers/openai-responses.js'
import { streamAnthropic, streamSimpleAnthropic } from '@mariozechner/pi-ai/dist/providers/anthropic.js'
import { EventStream, AssistantMessageEventStream, createAssistantMessageEventStream } from '@mariozechner/pi-ai/dist/utils/event-stream.js'
import { parseStreamingJson } from '@mariozechner/pi-ai/dist/utils/json-parse.js'
import { validateToolArguments, validateToolCall } from '@mariozechner/pi-ai/dist/utils/validation.js'
import { anthropicOAuthProvider, refreshAnthropicToken, loginAnthropic } from '@mariozechner/pi-ai/dist/utils/oauth/anthropic.js'
import { githubCopilotOAuthProvider, refreshGitHubCopilotToken, loginGitHubCopilot } from '@mariozechner/pi-ai/dist/utils/oauth/github-copilot.js'
import type { OAuthCredentials, OAuthProviderInterface, OAuthLoginCallbacks } from '@mariozechner/pi-ai/dist/utils/oauth/types.js'

type AnyModel = any
type AnyContext = any
type AnyOptions = any

function noProviderError(api: string): never {
  throw new Error(`No API provider registered for api: ${api}. This browser build supports openai-completions, openai-responses, and anthropic-messages.`)
}

export function stream(model: AnyModel, context: AnyContext, options?: AnyOptions) {
  if (model.api === 'openai-completions') {
    return streamOpenAICompletions(model, context, options)
  }

  if (model.api === 'openai-responses') {
    return streamOpenAIResponses(model, context, options)
  }

  if (model.api === 'anthropic-messages') {
    return streamAnthropic(model, context, options)
  }

  return noProviderError(model.api)
}

export function streamSimple(model: AnyModel, context: AnyContext, options?: AnyOptions) {
  if (model.api === 'openai-completions') {
    return streamSimpleOpenAICompletions(model, context, options)
  }

  if (model.api === 'openai-responses') {
    return streamSimpleOpenAIResponses(model, context, options)
  }

  if (model.api === 'anthropic-messages') {
    return streamSimpleAnthropic(model, context, options)
  }

  return noProviderError(model.api)
}

export async function complete(model: AnyModel, context: AnyContext, options?: AnyOptions) {
  const result = stream(model, context, options)
  return result.result()
}

export async function completeSimple(model: AnyModel, context: AnyContext, options?: AnyOptions) {
  const result = streamSimple(model, context, options)
  return result.result()
}

export {
  Type,
  getModel,
  getModels,
  getProviders,
  calculateCost,
  supportsXhigh,
  modelsAreEqual,
  EventStream,
  AssistantMessageEventStream,
  createAssistantMessageEventStream,
  parseStreamingJson,
  validateToolArguments,
  validateToolCall,
  // Anthropic streaming
  streamAnthropic,
  streamSimpleAnthropic,
  // OAuth providers
  anthropicOAuthProvider,
  refreshAnthropicToken,
  loginAnthropic,
  githubCopilotOAuthProvider,
  refreshGitHubCopilotToken,
  loginGitHubCopilot,
}

export type {
  OAuthCredentials,
  OAuthProviderInterface,
  OAuthLoginCallbacks,
}
