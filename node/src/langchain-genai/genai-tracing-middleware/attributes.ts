import { type ClientTool, type ServerTool } from '@langchain/core/tools'
import { type Span } from '@opentelemetry/api'

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const stringFieldOf = (
  value: unknown,
  key: string,
): string | undefined => {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

// AgentNode replaces the raw model response with a
// `{ structuredResponse, messages }` wrapper when it resolves a
// structured-output tool call or native-schema completion (see
// AgentNode#invokeModel / #handleSingleStructuredOutput in langchain's
// dist/agents/nodes/AgentNode.js). The raw AIMessage — the one carrying
// usage_metadata/response_metadata — ends up at messages[0] instead of
// being the response itself.
export const rawResponseMessageOf = (response: unknown): unknown => {
  if (
    !isRecord(response) ||
    !('structuredResponse' in response) ||
    !Array.isArray(response['messages'])
  ) {
    return response
  }
  return response['messages'][0]
}

// AIMessage#response_metadata is typed as Record<string, any>: chat model
// integrations (e.g. @langchain/openai) merge their provider-specific
// response fields (finish_reason, model_name, ...) into it uniformly,
// whether the call streamed internally or not.
export const responseMetadataString = (
  message: unknown,
  key: string,
): string | undefined => {
  if (!isRecord(message)) return undefined
  return stringFieldOf(message['response_metadata'], key)
}

export interface UsageTokens {
  readonly inputTokens: number
  readonly outputTokens: number
}

// AIMessage#usage_metadata is typed through a generic MessageStructure that
// resolves to `undefined` unless the message was constructed with an
// explicit structure parameter, which a handler-returned AIMessage never
// carries — so this reads the field at runtime instead of through the
// (uninformative) static type.
export const usageTokensOf = (message: unknown): UsageTokens | undefined => {
  if (!isRecord(message)) return undefined
  const usageMetadata = message['usage_metadata']
  if (!isRecord(usageMetadata)) return undefined
  const inputTokens = usageMetadata['input_tokens']
  const outputTokens = usageMetadata['output_tokens']
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
    return undefined
  }
  return { inputTokens, outputTokens }
}

// request.model is typed as the generic AgentLanguageModelLike (a bare
// Runnable), but chat model integrations (e.g. ChatOpenAI) expose the
// requested model id as a public `model` field, so this reads it at runtime
// instead of through that uninformative static type.
export const requestModelOf = (model: unknown): string | undefined =>
  stringFieldOf(model, 'model')

export const recordSpanException = (span: Span, error: unknown): void => {
  span.recordException(error instanceof Error ? error : String(error))
}

// request.tool is typed as ClientTool | ServerTool | undefined, where
// ServerTool is a bare Record<string, unknown> and dynamically registered
// tools have no request.tool at all, so this reads the field at runtime
// instead of through that uninformative static type.
export const toolDescriptionOf = (
  tool: ClientTool | ServerTool | undefined,
): string | undefined => stringFieldOf(tool, 'description')
