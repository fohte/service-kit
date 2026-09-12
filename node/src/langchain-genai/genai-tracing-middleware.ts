import { ToolMessage } from '@langchain/core/messages'
import { isLangChainTool } from '@langchain/core/tools'
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import {
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_DESCRIPTION,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
} from '@opentelemetry/semantic-conventions/incubating'
import { createMiddleware } from 'langchain'
import { Result } from 'neverthrow'

import {
  rawResponseMessageOf,
  recordSpanException,
  requestModelOf,
  responseMetadataString,
  toolDescriptionOf,
  usageTokensOf,
} from './genai-tracing-middleware/attributes'
import {
  messageToGenAiMessage,
  outputMessagesOf,
} from './genai-tracing-middleware/messages'

// The semconv package exports GEN_AI_OPERATION_NAME_VALUE_CHAT but has no
// equivalent constant for gen_ai.tool.type's "function" value.
const GEN_AI_TOOL_TYPE_VALUE_FUNCTION = 'function'

// Mirrors the env var used by other OpenTelemetry GenAI instrumentations
// (e.g. opentelemetry-instrumentation-openai-v2, Elastic's EDOT Node.js SDK)
// to gate capture of message content, which is opt-in per the GenAI semantic
// conventions because it may contain PII.
const CAPTURE_MESSAGE_CONTENT_ENV_VAR =
  'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'

const TRACER_NAME = '@fohte/service-kit/langchain-genai'

export interface GenAiTracingMiddlewareOptions {
  readonly providerName: string
  readonly captureMessageContent?: boolean | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

// One CLIENT span per model inference call, matching the GenAI semantic
// conventions' `{gen_ai.operation.name} {gen_ai.request.model}` span. Wraps
// the actual model invocation (langchain's wrapModelCall middleware hook)
// so the span stays active in context for the call's duration, letting any
// HTTP instrumentation spans it produces (e.g. undici's span for the
// underlying fetch) nest under it as children rather than landing as
// unrelated siblings.
export const createGenAiTracingMiddleware = (
  options: GenAiTracingMiddlewareOptions,
) => {
  const providerName = options.providerName
  const captureMessageContent =
    options.captureMessageContent ??
    (options.env ?? process.env)[CAPTURE_MESSAGE_CONTENT_ENV_VAR] === 'true'

  return createMiddleware({
    name: 'GenAiTracingMiddleware',
    wrapModelCall: async (request, handler) => {
      const requestModel = requestModelOf(request.model) ?? 'unknown'
      // Resolved per call (not cached at module scope): the OTel API's
      // ProxyTracer freezes its delegate on first use, so a module-level
      // tracer captured before the SDK registers a provider would keep
      // pointing at whatever provider was active at that first call forever.
      const tracer = trace.getTracer(TRACER_NAME)
      // eslint-disable-next-line no-restricted-syntax -- put into the active context via context.with() below, so spans created during the model call (e.g. undici's HTTP span) nest under it correctly
      const span = tracer.startSpan(
        `${GEN_AI_OPERATION_NAME_VALUE_CHAT} ${requestModel}`,
        { kind: SpanKind.CLIENT },
      )
      span.setAttributes({
        [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
        [ATTR_GEN_AI_PROVIDER_NAME]: providerName,
        [ATTR_GEN_AI_REQUEST_MODEL]: requestModel,
      })
      if (captureMessageContent) {
        // Result.fromThrowable, not try/catch: a serialization error here
        // must not fail the model call itself, only be recorded on the span.
        const buildInputMessagesJson = Result.fromThrowable(
          (): string => {
            // request.systemMessage is a separate field from
            // request.messages (createAgent's systemPrompt/systemMessage
            // option), but it's still the first message actually sent to
            // the model.
            const systemMessage =
              request.systemMessage.text.length > 0
                ? [messageToGenAiMessage(request.systemMessage)]
                : []
            return JSON.stringify([
              ...systemMessage,
              ...request.messages.map(messageToGenAiMessage),
            ])
          },
          (error) => error,
        )
        buildInputMessagesJson().match(
          (json) => {
            span.setAttribute(ATTR_GEN_AI_INPUT_MESSAGES, json)
          },
          (error) => {
            recordSpanException(span, error)
          },
        )
      }

      const spanContext = trace.setSpan(context.active(), span)
      // eslint-disable-next-line no-restricted-syntax -- boundary: wraps LangChain's throw-based wrapModelCall handler contract; finally guarantees span.end() runs even when the model call throws
      try {
        const response = await context.with(spanContext, () => handler(request))
        const rawResponse = rawResponseMessageOf(response)
        const responseModel = responseMetadataString(rawResponse, 'model_name')
        if (responseModel !== undefined) {
          span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, responseModel)
        }
        const usage = usageTokensOf(rawResponse)
        if (usage !== undefined) {
          span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, usage.inputTokens)
          span.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, usage.outputTokens)
        }
        const finishReason = responseMetadataString(
          rawResponse,
          'finish_reason',
        )
        if (finishReason !== undefined) {
          span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, [finishReason])
        }
        if (captureMessageContent) {
          const outputMessages = outputMessagesOf(rawResponse)
          if (outputMessages !== undefined) {
            const buildOutputMessagesJson = Result.fromThrowable(
              (): string => JSON.stringify(outputMessages),
              (error) => error,
            )
            buildOutputMessagesJson().match(
              (json) => {
                span.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, json)
              },
              (error) => {
                recordSpanException(span, error)
              },
            )
          }
        }
        return response
      } catch (error) {
        recordSpanException(span, error)
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        })
        // eslint-disable-next-line no-restricted-syntax -- boundary: LangChain's wrapModelCall middleware contract requires either returning the handler's result or re-throwing its error
        throw error
      } finally {
        span.end()
      }
    },
    // One INTERNAL span per tool call, matching the GenAI semantic
    // conventions' `execute_tool {gen_ai.tool.name}` span. INTERNAL (not
    // CLIENT, unlike the chat span above) because tool execution runs
    // in-process rather than calling out to the GenAI provider. Wraps the
    // actual tool invocation so the span stays active in context for the
    // call's duration, letting any instrumentation spans the tool
    // implementation produces (e.g. an HTTP call it makes) nest under it as
    // children rather than landing as unrelated siblings.
    wrapToolCall: async (request, handler) => {
      const toolName = request.toolCall.name
      const tracer = trace.getTracer(TRACER_NAME)
      // eslint-disable-next-line no-restricted-syntax -- put into the active context via context.with() below, so spans created during the tool call (e.g. an HTTP span from the tool's implementation) nest under it correctly
      const span = tracer.startSpan(
        `${GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL} ${toolName}`,
        { kind: SpanKind.INTERNAL },
      )
      span.setAttributes({
        [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
        [ATTR_GEN_AI_TOOL_NAME]: toolName,
      })
      // request.tool is a ServerTool (a provider-executed tool, e.g. a
      // vendor's built-in web search) for tool calls that never reach a
      // LangChain tool implementation, so "function" — semconv's value for a
      // client-side tool call — would misdescribe those.
      if (isLangChainTool(request.tool)) {
        span.setAttribute(
          ATTR_GEN_AI_TOOL_TYPE,
          GEN_AI_TOOL_TYPE_VALUE_FUNCTION,
        )
      }
      if (request.toolCall.id !== undefined) {
        span.setAttribute(ATTR_GEN_AI_TOOL_CALL_ID, request.toolCall.id)
      }
      const toolDescription = toolDescriptionOf(request.tool)
      if (toolDescription !== undefined) {
        span.setAttribute(ATTR_GEN_AI_TOOL_DESCRIPTION, toolDescription)
      }
      if (captureMessageContent) {
        // Result.fromThrowable, not try/catch: a serialization error here
        // must not fail the tool call itself, only be recorded on the span.
        const buildArgumentsJson = Result.fromThrowable(
          (): string => JSON.stringify(request.toolCall.args),
          (error) => error,
        )
        buildArgumentsJson().match(
          (json) => {
            span.setAttribute(ATTR_GEN_AI_TOOL_CALL_ARGUMENTS, json)
          },
          (error) => {
            recordSpanException(span, error)
          },
        )
      }

      const spanContext = trace.setSpan(context.active(), span)
      // eslint-disable-next-line no-restricted-syntax -- boundary: wraps LangChain's throw-based wrapToolCall handler contract; finally guarantees span.end() runs even when the tool call throws
      try {
        const result = await context.with(spanContext, () => handler(request))
        if (ToolMessage.isInstance(result)) {
          if (result.status === 'error') {
            span.setStatus({ code: SpanStatusCode.ERROR })
          }
          if (captureMessageContent) {
            // Result.fromThrowable, not try/catch: a serialization error
            // here must not fail the tool call itself, only be recorded on
            // the span.
            const buildResult = Result.fromThrowable(
              (): string => {
                const content = result.content
                return typeof content === 'string'
                  ? content
                  : JSON.stringify(content)
              },
              (error) => error,
            )
            buildResult().match(
              (resultString) => {
                span.setAttribute(ATTR_GEN_AI_TOOL_CALL_RESULT, resultString)
              },
              (error) => {
                recordSpanException(span, error)
              },
            )
          }
        }
        return result
      } catch (error) {
        recordSpanException(span, error)
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        })
        // eslint-disable-next-line no-restricted-syntax -- boundary: LangChain's wrapToolCall middleware contract requires either returning the handler's result or re-throwing its error
        throw error
      } finally {
        span.end()
      }
    },
  })
}
