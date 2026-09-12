import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
} from '@langchain/core/messages'

import { isRecord, responseMetadataString } from './attributes'

// Shapes below follow the GenAI semantic conventions' message format
// (gen_ai.input.messages / gen_ai.output.messages):
// https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md

interface GenAiTextPart {
  readonly type: 'text'
  readonly content: string
}

interface GenAiToolCallPart {
  readonly type: 'tool_call'
  readonly id: string
  readonly name: string
  readonly arguments: unknown
}

interface GenAiToolCallResponsePart {
  readonly type: 'tool_call_response'
  readonly id: string
  readonly response: string
}

interface GenAiReasoningPart {
  readonly type: 'reasoning'
  readonly content: string
}

type GenAiMessagePart =
  | GenAiTextPart
  | GenAiToolCallPart
  | GenAiToolCallResponsePart
  | GenAiReasoningPart

interface GenAiMessage {
  readonly role: string
  readonly parts: readonly GenAiMessagePart[]
}

interface GenAiOutputMessage extends GenAiMessage {
  readonly finish_reason?: string
}

const roleForMessage = (message: BaseMessage): string => {
  if (message.type === 'human') return 'user'
  if (message.type === 'ai') return 'assistant'
  return message.type
}

// Raw image bytes are redacted: they bloat span payloads and, unlike text,
// carry no debugging value once reduced to an opaque data URL.
const contentToGenAiParts = (
  content: BaseMessage['content'],
): GenAiMessagePart[] => {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', content }]
  }
  return content.map((block): GenAiMessagePart => {
    if (typeof block === 'string') {
      return { type: 'text', content: block }
    }
    if (isRecord(block) && block['type'] === 'text' && 'text' in block) {
      const text = block['text']
      return { type: 'text', content: typeof text === 'string' ? text : '' }
    }
    // @langchain/core's standard content block union includes a `reasoning`
    // block (distinct from the `additional_kwargs.reasoning_content` field
    // some provider integrations use instead — see reasoningPartsOf below).
    if (
      isRecord(block) &&
      block['type'] === 'reasoning' &&
      'reasoning' in block
    ) {
      const text = block['reasoning']
      return {
        type: 'reasoning',
        content: typeof text === 'string' ? text : '',
      }
    }
    const blockType =
      isRecord(block) && typeof block['type'] === 'string'
        ? block['type']
        : 'unknown'
    return { type: 'text', content: `[${blockType} omitted]` }
  })
}

const toolCallsToGenAiParts = (message: BaseMessage): GenAiToolCallPart[] => {
  if (!AIMessage.isInstance(message)) return []
  const toolCalls = message.tool_calls ?? []
  return toolCalls.map((call) => ({
    type: 'tool_call',
    id: call.id ?? '',
    name: call.name,
    arguments: call.args,
  }))
}

export const messageToGenAiMessage = (message: BaseMessage): GenAiMessage => {
  if (ToolMessage.isInstance(message)) {
    const content = message.content
    return {
      role: 'tool',
      parts: [
        {
          type: 'tool_call_response',
          id: message.tool_call_id,
          response:
            typeof content === 'string' ? content : JSON.stringify(content),
        },
      ],
    }
  }
  return {
    role: roleForMessage(message),
    parts: [
      ...contentToGenAiParts(message.content),
      ...toolCallsToGenAiParts(message),
    ],
  }
}

// @langchain/openai reads the upstream provider's `reasoning_content`
// response field (set when the model call requests
// `modelKwargs: { reasoning_split: true }`) into this field rather than
// `message.content`, so contentToGenAiParts alone never sees it.
const reasoningPartsOf = (message: AIMessage): GenAiReasoningPart[] => {
  const reasoningContent = message.additional_kwargs['reasoning_content']
  return typeof reasoningContent === 'string' && reasoningContent.length > 0
    ? [{ type: 'reasoning', content: reasoningContent }]
    : []
}

export const outputMessagesOf = (
  message: unknown,
): GenAiOutputMessage[] | undefined => {
  if (!AIMessage.isInstance(message)) return undefined
  const base = messageToGenAiMessage(message)
  const withReasoning = {
    ...base,
    parts: [...reasoningPartsOf(message), ...base.parts],
  }
  const finishReason = responseMetadataString(message, 'finish_reason')
  return [
    finishReason === undefined
      ? withReasoning
      : { ...withReasoning, finish_reason: finishReason },
  ]
}
