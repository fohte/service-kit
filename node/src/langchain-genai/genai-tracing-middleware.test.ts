import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages'
import type { Attributes } from '@opentelemetry/api'
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createGenAiTracingMiddleware } from '#langchain-genai/genai-tracing-middleware'

interface SpanRow {
  readonly name: string
  readonly kind: SpanKind
  readonly attributes: Attributes
  readonly statusCode: SpanStatusCode
}

let spanExporter: InMemorySpanExporter
let tracerProvider: BasicTracerProvider
let contextManager: AsyncLocalStorageContextManager

const collectSpans = async (): Promise<readonly SpanRow[]> => {
  await tracerProvider.forceFlush()
  return spanExporter.getFinishedSpans().map((s) => ({
    name: s.name,
    kind: s.kind,
    attributes: s.attributes,
    statusCode: s.status.code,
  }))
}

beforeEach(() => {
  spanExporter = new InMemorySpanExporter()
  tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  })
  trace.setGlobalTracerProvider(tracerProvider)
  // Without a real context manager, context.with() is a no-op (the API's
  // default NoopContextManager ignores the context it's given), so the
  // parent-child nesting this middleware exists to produce can't be
  // observed under the default setup.
  contextManager = new AsyncLocalStorageContextManager()
  contextManager.enable()
  context.setGlobalContextManager(contextManager)
})

afterEach(async () => {
  await tracerProvider.shutdown()
  trace.disable()
  context.disable()
  contextManager.disable()
})

type Middleware = ReturnType<typeof createGenAiTracingMiddleware>
type WrapModelCall = NonNullable<Middleware['wrapModelCall']>
type FakeRequest = Parameters<WrapModelCall>[0]

const wrapModelCallOf = (middleware: Middleware): WrapModelCall => {
  const { wrapModelCall } = middleware
  if (wrapModelCall === undefined) {
    throw new Error('expected middleware.wrapModelCall to be defined')
  }
  return wrapModelCall
}

type WrapToolCall = NonNullable<Middleware['wrapToolCall']>
type FakeToolCallRequest = Parameters<WrapToolCall>[0]

const wrapToolCallOf = (middleware: Middleware): WrapToolCall => {
  const { wrapToolCall } = middleware
  if (wrapToolCall === undefined) {
    throw new Error('expected middleware.wrapToolCall to be defined')
  }
  return wrapToolCall
}

// wrapToolCall's request carries the full agent runtime (state, runtime),
// none of which this middleware reads; only `toolCall` and `tool` matter to
// it, so the rest is asserted away rather than fully constructed.
const fakeToolCallRequest = (
  toolCall: FakeToolCallRequest['toolCall'],
  tool?: FakeToolCallRequest['tool'],
): FakeToolCallRequest =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- deliberately partial: only the fields wrapToolCall actually reads (see comment above)
  ({ toolCall, tool }) as unknown as FakeToolCallRequest

// wrapModelCall's request carries the full agent runtime (state, tools,
// runtime context, ...), none of which this middleware reads; only `model`,
// `messages`, and `systemMessage` matter to it, so the rest is asserted away
// rather than fully constructed. `systemMessage` defaults to an empty
// SystemMessage, mirroring ModelRequest's own default when createAgent was
// never given a systemPrompt.
const fakeRequest = (
  model: unknown,
  messages: FakeRequest['messages'],
  systemMessage: FakeRequest['systemMessage'] = new SystemMessage(''),
): FakeRequest =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- deliberately partial: only the fields wrapModelCall actually reads (see comment above)
  ({ model, messages, systemMessage }) as unknown as FakeRequest

const defaultMiddleware = (): WrapModelCall =>
  wrapModelCallOf(createGenAiTracingMiddleware({ providerName: 'opencode' }))

const capturingMiddleware = (): WrapModelCall =>
  wrapModelCallOf(
    createGenAiTracingMiddleware({
      providerName: 'opencode',
      captureMessageContent: true,
    }),
  )

describe('createGenAiTracingMiddleware', () => {
  it('records a CLIENT span with GenAI attributes on success', async () => {
    const wrapModelCall = defaultMiddleware()
    const aiMessage = new AIMessage({
      content: 'hello there',
      response_metadata: {
        model_name: 'opencode-go/gpt-5-2025',
        finish_reason: 'stop',
      },
    })
    // AIMessage's usage_metadata is only typed through a generic structure
    // parameter that a plain `new AIMessage({...})` call can't infer;
    // Object.assign sidesteps that generic without weakening the field's
    // runtime shape (verified by genai-tracing-middleware.ts's own read
    // path).
    Object.assign(aiMessage, {
      usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    })

    await wrapModelCall(
      fakeRequest({ model: 'opencode-go/gpt-5' }, [new HumanMessage('hi')]),
      () => Promise.resolve(aiMessage),
    )

    expect(await collectSpans()).toEqual([
      {
        name: 'chat opencode-go/gpt-5',
        kind: SpanKind.CLIENT,
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'opencode',
          'gen_ai.request.model': 'opencode-go/gpt-5',
          'gen_ai.response.model': 'opencode-go/gpt-5-2025',
          'gen_ai.usage.input_tokens': 10,
          'gen_ai.usage.output_tokens': 5,
          'gen_ai.response.finish_reasons': ['stop'],
        },
        statusCode: SpanStatusCode.UNSET,
      },
    ])
  })

  it('falls back to "unknown" for the request model when request.model has no model field', async () => {
    const wrapModelCall = defaultMiddleware()

    await wrapModelCall(fakeRequest({}, [new HumanMessage('hi')]), () =>
      Promise.resolve(new AIMessage('ok')),
    )

    expect(await collectSpans()).toEqual([
      {
        name: 'chat unknown',
        kind: SpanKind.CLIENT,
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'opencode',
          'gen_ai.request.model': 'unknown',
        },
        statusCode: SpanStatusCode.UNSET,
      },
    ])
  })

  it("returns the handler's response unchanged", async () => {
    const wrapModelCall = defaultMiddleware()
    const aiMessage = new AIMessage('hello there')

    const response = await wrapModelCall(
      fakeRequest({ model: 'opencode-go/gpt-5' }, [new HumanMessage('hi')]),
      () => Promise.resolve(aiMessage),
    )

    expect(response).toBe(aiMessage)
  })

  // context.with() puts the span in the active context for the call's
  // duration, so any span the handler creates (e.g. undici's HTTP span)
  // nests under it as a child.
  it("runs the handler inside the span's active context, so a span created during the call becomes its child", async () => {
    const wrapModelCall = defaultMiddleware()

    await wrapModelCall(
      fakeRequest({ model: 'opencode-go/gpt-5' }, [new HumanMessage('hi')]),
      () => {
        trace.getTracer('test').startSpan('POST').end()
        return Promise.resolve(new AIMessage('hello there'))
      },
    )

    const spans = spanExporter.getFinishedSpans()
    const chatSpan = spans.find((s) => s.name === 'chat opencode-go/gpt-5')
    const httpSpan = spans.find((s) => s.name === 'POST')
    if (chatSpan === undefined || httpSpan === undefined) {
      throw new Error(
        'expected both the chat span and the HTTP span to be recorded',
      )
    }
    expect(httpSpan.parentSpanContext?.spanId).toBe(
      chatSpan.spanContext().spanId,
    )
  })

  // langchain's AgentNode resolves handler() to a { structuredResponse,
  // messages } object instead of an AIMessage when the agent uses a native
  // structured-output response format (see AgentNode#invokeModel's
  // baseHandler in langchain@1.5.3's dist/agents/nodes/AgentNode.js), even
  // though WrapModelCallHandler's static type promises an AIMessage.
  it('does not throw when the handler resolves to a response with no response_metadata', async () => {
    const wrapModelCall = defaultMiddleware()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- deliberately a non-AIMessage stand-in (see comment above)
    const structuredResponse = {
      structuredResponse: { city: 'Tokyo' },
      messages: [new AIMessage('final')],
    } as unknown as AIMessage

    const response = await wrapModelCall(
      fakeRequest({ model: 'opencode-go/gpt-5' }, [new HumanMessage('hi')]),
      () => Promise.resolve(structuredResponse),
    )

    expect(response).toBe(structuredResponse)
    expect(await collectSpans()).toEqual([
      {
        name: 'chat opencode-go/gpt-5',
        kind: SpanKind.CLIENT,
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'opencode',
          'gen_ai.request.model': 'opencode-go/gpt-5',
        },
        statusCode: SpanStatusCode.UNSET,
      },
    ])
  })

  it('omits gen_ai.output.messages when capturing is enabled and the handler resolves to a non-AIMessage response', async () => {
    const wrapModelCall = capturingMiddleware()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- deliberately a non-AIMessage stand-in (see comment above the previous test)
    const structuredResponse = {
      structuredResponse: { city: 'Tokyo' },
      messages: [new AIMessage('final')],
    } as unknown as AIMessage

    await wrapModelCall(
      fakeRequest({ model: 'opencode-go/gpt-5' }, [new HumanMessage('hi')]),
      () => Promise.resolve(structuredResponse),
    )

    expect(await collectSpans()).toEqual([
      {
        name: 'chat opencode-go/gpt-5',
        kind: SpanKind.CLIENT,
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'opencode',
          'gen_ai.request.model': 'opencode-go/gpt-5',
          'gen_ai.input.messages': JSON.stringify([
            { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
          ]),
        },
        statusCode: SpanStatusCode.UNSET,
      },
    ])
  })

  it('rethrows the error the handler throws', async () => {
    const wrapModelCall = defaultMiddleware()
    const error = new Error('go usage limit')

    await expect(
      wrapModelCall(
        fakeRequest({ model: 'opencode-go/gpt-5' }, [new HumanMessage('hi')]),
        () => {
          throw error
        },
      ),
    ).rejects.toBe(error)
  })

  it('records an ERROR span when the handler fails', async () => {
    const wrapModelCall = defaultMiddleware()

    try {
      await wrapModelCall(
        fakeRequest({ model: 'opencode-go/gpt-5' }, [new HumanMessage('hi')]),
        () => {
          throw new Error('go usage limit')
        },
      )
    } catch {
      // asserted by the 'rethrows the error the handler throws' test above
    }

    expect(await collectSpans()).toEqual([
      {
        name: 'chat opencode-go/gpt-5',
        kind: SpanKind.CLIENT,
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'opencode',
          'gen_ai.request.model': 'opencode-go/gpt-5',
        },
        statusCode: SpanStatusCode.ERROR,
      },
    ])
  })

  it('omits message content by default', async () => {
    const wrapModelCall = defaultMiddleware()

    await wrapModelCall(
      fakeRequest({ model: 'opencode-go/gpt-5' }, [
        new SystemMessage('persona'),
        new HumanMessage('secret question'),
      ]),
      () => Promise.resolve(new AIMessage('secret reply')),
    )

    expect(await collectSpans()).toEqual([
      {
        name: 'chat opencode-go/gpt-5',
        kind: SpanKind.CLIENT,
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'opencode',
          'gen_ai.request.model': 'opencode-go/gpt-5',
        },
        statusCode: SpanStatusCode.UNSET,
      },
    ])
  })

  it('captures redacted message content when opted in', async () => {
    const wrapModelCall = capturingMiddleware()

    await wrapModelCall(
      fakeRequest({ model: 'opencode-go/gpt-5' }, [
        new HumanMessage({
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', mimeType: 'image/jpeg', data: 'BASE64DATA' },
          ],
        }),
      ]),
      () =>
        Promise.resolve(
          new AIMessage({
            content: 'described the photo',
            response_metadata: { finish_reason: 'stop' },
          }),
        ),
    )

    expect(await collectSpans()).toEqual([
      {
        name: 'chat opencode-go/gpt-5',
        kind: SpanKind.CLIENT,
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'opencode',
          'gen_ai.request.model': 'opencode-go/gpt-5',
          'gen_ai.response.finish_reasons': ['stop'],
          'gen_ai.input.messages': JSON.stringify([
            {
              role: 'user',
              parts: [
                { type: 'text', content: 'what is this?' },
                { type: 'text', content: '[image omitted]' },
              ],
            },
          ]),
          'gen_ai.output.messages': JSON.stringify([
            {
              role: 'assistant',
              parts: [{ type: 'text', content: 'described the photo' }],
              finish_reason: 'stop',
            },
          ]),
        },
        statusCode: SpanStatusCode.UNSET,
      },
    ])
  })

  it.each<{
    scenario: string
    systemMessage: SystemMessage
    inputMessages: readonly unknown[]
  }>([
    {
      scenario: 'includes it as the first entry when it has content',
      systemMessage: new SystemMessage('persona'),
      inputMessages: [
        { role: 'system', parts: [{ type: 'text', content: 'persona' }] },
        { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
      ],
    },
    {
      scenario: 'omits it when it is empty',
      systemMessage: new SystemMessage(''),
      inputMessages: [
        { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
      ],
    },
  ])(
    'request.systemMessage: $scenario',
    async ({ systemMessage, inputMessages }) => {
      const wrapModelCall = capturingMiddleware()

      await wrapModelCall(
        fakeRequest(
          { model: 'opencode-go/gpt-5' },
          [new HumanMessage('hi')],
          systemMessage,
        ),
        () => Promise.resolve(new AIMessage('ok')),
      )

      expect(await collectSpans()).toEqual([
        {
          name: 'chat opencode-go/gpt-5',
          kind: SpanKind.CLIENT,
          attributes: {
            'gen_ai.operation.name': 'chat',
            'gen_ai.provider.name': 'opencode',
            'gen_ai.request.model': 'opencode-go/gpt-5',
            'gen_ai.input.messages': JSON.stringify(inputMessages),
            'gen_ai.output.messages': JSON.stringify([
              { role: 'assistant', parts: [{ type: 'text', content: 'ok' }] },
            ]),
          },
          statusCode: SpanStatusCode.UNSET,
        },
      ])
    },
  )

  it('includes additional_kwargs.reasoning_content as a leading reasoning part in gen_ai.output.messages', async () => {
    const wrapModelCall = capturingMiddleware()
    const aiMessage = new AIMessage({
      content: 'final answer',
      additional_kwargs: { reasoning_content: 'thinking it through' },
    })

    await wrapModelCall(
      fakeRequest({ model: 'opencode-go/gpt-5' }, [new HumanMessage('hi')]),
      () => Promise.resolve(aiMessage),
    )

    expect(await collectSpans()).toEqual([
      {
        name: 'chat opencode-go/gpt-5',
        kind: SpanKind.CLIENT,
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'opencode',
          'gen_ai.request.model': 'opencode-go/gpt-5',
          'gen_ai.input.messages': JSON.stringify([
            { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
          ]),
          'gen_ai.output.messages': JSON.stringify([
            {
              role: 'assistant',
              parts: [
                { type: 'reasoning', content: 'thinking it through' },
                { type: 'text', content: 'final answer' },
              ],
            },
          ]),
        },
        statusCode: SpanStatusCode.UNSET,
      },
    ])
  })

  it('captures a standard reasoning content block as a leading reasoning part in gen_ai.output.messages', async () => {
    const wrapModelCall = capturingMiddleware()
    const aiMessage = new AIMessage({
      content: [
        { type: 'reasoning', reasoning: 'thinking it through' },
        { type: 'text', text: 'final answer' },
      ],
    })

    await wrapModelCall(
      fakeRequest({ model: 'opencode-go/gpt-5' }, [new HumanMessage('hi')]),
      () => Promise.resolve(aiMessage),
    )

    expect(await collectSpans()).toEqual([
      {
        name: 'chat opencode-go/gpt-5',
        kind: SpanKind.CLIENT,
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'opencode',
          'gen_ai.request.model': 'opencode-go/gpt-5',
          'gen_ai.input.messages': JSON.stringify([
            { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
          ]),
          'gen_ai.output.messages': JSON.stringify([
            {
              role: 'assistant',
              parts: [
                { type: 'reasoning', content: 'thinking it through' },
                { type: 'text', content: 'final answer' },
              ],
            },
          ]),
        },
        statusCode: SpanStatusCode.UNSET,
      },
    ])
  })

  it('includes tool_calls as tool_call parts in gen_ai.output.messages', async () => {
    const wrapModelCall = capturingMiddleware()
    const aiMessage = new AIMessage({
      content: '',
      tool_calls: [
        { id: 'call_1', name: 'get_weather', args: { city: 'Tokyo' } },
      ],
    })

    await wrapModelCall(
      fakeRequest({ model: 'opencode-go/gpt-5' }, [new HumanMessage('hi')]),
      () => Promise.resolve(aiMessage),
    )

    expect(await collectSpans()).toEqual([
      {
        name: 'chat opencode-go/gpt-5',
        kind: SpanKind.CLIENT,
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'opencode',
          'gen_ai.request.model': 'opencode-go/gpt-5',
          'gen_ai.input.messages': JSON.stringify([
            { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
          ]),
          'gen_ai.output.messages': JSON.stringify([
            {
              role: 'assistant',
              parts: [
                {
                  type: 'tool_call',
                  id: 'call_1',
                  name: 'get_weather',
                  arguments: { city: 'Tokyo' },
                },
              ],
            },
          ]),
        },
        statusCode: SpanStatusCode.UNSET,
      },
    ])
  })

  it('captures a ToolMessage in request.messages as a tool_call_response part with role "tool"', async () => {
    const wrapModelCall = capturingMiddleware()
    const toolMessage = new ToolMessage({
      content: '{"temperature":21}',
      tool_call_id: 'call_1',
    })

    await wrapModelCall(
      fakeRequest({ model: 'opencode-go/gpt-5' }, [
        new HumanMessage('hi'),
        toolMessage,
      ]),
      () => Promise.resolve(new AIMessage('ok')),
    )

    expect(await collectSpans()).toEqual([
      {
        name: 'chat opencode-go/gpt-5',
        kind: SpanKind.CLIENT,
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'opencode',
          'gen_ai.request.model': 'opencode-go/gpt-5',
          'gen_ai.input.messages': JSON.stringify([
            { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
            {
              role: 'tool',
              parts: [
                {
                  type: 'tool_call_response',
                  id: 'call_1',
                  response: '{"temperature":21}',
                },
              ],
            },
          ]),
          'gen_ai.output.messages': JSON.stringify([
            { role: 'assistant', parts: [{ type: 'text', content: 'ok' }] },
          ]),
        },
        statusCode: SpanStatusCode.UNSET,
      },
    ])
  })

  it('captures a bare string element inside a content array as text', async () => {
    const wrapModelCall = capturingMiddleware()
    // BaseMessage['content'] is typed as string | ContentBlock[], but
    // @langchain/core's own BaseMessage#text getter defensively handles a
    // bare string inside that array too, so upstream message sources can
    // still produce this shape; the constructor won't accept it directly,
    // so it's assigned here to exercise it.
    const humanMessage = new HumanMessage('placeholder')
    Object.assign(humanMessage, { content: ['plain string element'] })

    await wrapModelCall(
      fakeRequest({ model: 'opencode-go/gpt-5' }, [humanMessage]),
      () => Promise.resolve(new AIMessage('ok')),
    )

    expect(await collectSpans()).toEqual([
      {
        name: 'chat opencode-go/gpt-5',
        kind: SpanKind.CLIENT,
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': 'opencode',
          'gen_ai.request.model': 'opencode-go/gpt-5',
          'gen_ai.input.messages': JSON.stringify([
            {
              role: 'user',
              parts: [{ type: 'text', content: 'plain string element' }],
            },
          ]),
          'gen_ai.output.messages': JSON.stringify([
            { role: 'assistant', parts: [{ type: 'text', content: 'ok' }] },
          ]),
        },
        statusCode: SpanStatusCode.UNSET,
      },
    ])
  })

  describe('wrapToolCall', () => {
    const defaultToolCallMiddleware = (): WrapToolCall =>
      wrapToolCallOf(createGenAiTracingMiddleware({ providerName: 'opencode' }))

    const capturingToolCallMiddleware = (): WrapToolCall =>
      wrapToolCallOf(
        createGenAiTracingMiddleware({
          providerName: 'opencode',
          captureMessageContent: true,
        }),
      )

    // Satisfies isLangChainTool's isStructuredToolParams check (name +
    // schema), which is what gates gen_ai.tool.type: 'function' — a plain
    // { description } object, as used for the "unavailable" case below,
    // does not.
    const fakeClientTool: FakeToolCallRequest['tool'] = {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      schema: { type: 'object' },
    }

    it('records an INTERNAL span with GenAI tool attributes on success', async () => {
      const wrapToolCall = defaultToolCallMiddleware()

      await wrapToolCall(
        fakeToolCallRequest(
          { id: 'call_1', name: 'get_weather', args: { city: 'Tokyo' } },
          fakeClientTool,
        ),
        () =>
          Promise.resolve(
            new ToolMessage({
              content: '{"temperature":21}',
              tool_call_id: 'call_1',
            }),
          ),
      )

      expect(await collectSpans()).toEqual([
        {
          name: 'execute_tool get_weather',
          kind: SpanKind.INTERNAL,
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': 'get_weather',
            'gen_ai.tool.type': 'function',
            'gen_ai.tool.call.id': 'call_1',
            'gen_ai.tool.description': 'Get the current weather for a city',
          },
          statusCode: SpanStatusCode.UNSET,
        },
      ])
    })

    it('omits tool.call.id, tool.description, and tool.type when request.tool is unavailable', async () => {
      const wrapToolCall = defaultToolCallMiddleware()

      await wrapToolCall(
        fakeToolCallRequest({ name: 'get_weather', args: {} }),
        () =>
          Promise.resolve(
            new ToolMessage({ content: 'ok', tool_call_id: 'call_1' }),
          ),
      )

      expect(await collectSpans()).toEqual([
        {
          name: 'execute_tool get_weather',
          kind: SpanKind.INTERNAL,
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': 'get_weather',
          },
          statusCode: SpanStatusCode.UNSET,
        },
      ])
    })

    // request.tool is a ServerTool (e.g. a vendor's built-in web search)
    // for tool calls a LangChain tool implementation never handles, so
    // gen_ai.tool.type's "function" value (semconv's value for a
    // client-side tool call) would misdescribe it.
    it('omits tool.type for a ServerTool that is not a recognized LangChain client tool', async () => {
      const wrapToolCall = defaultToolCallMiddleware()

      await wrapToolCall(
        fakeToolCallRequest(
          { name: 'web_search', args: {} },
          { type: 'web_search' },
        ),
        () =>
          Promise.resolve(
            new ToolMessage({ content: 'ok', tool_call_id: 'call_1' }),
          ),
      )

      expect(await collectSpans()).toEqual([
        {
          name: 'execute_tool web_search',
          kind: SpanKind.INTERNAL,
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': 'web_search',
          },
          statusCode: SpanStatusCode.UNSET,
        },
      ])
    })

    it("returns the handler's tool result unchanged", async () => {
      const wrapToolCall = defaultToolCallMiddleware()
      const toolMessage = new ToolMessage({
        content: 'ok',
        tool_call_id: 'call_1',
      })

      const response = await wrapToolCall(
        fakeToolCallRequest({ name: 'get_weather', args: {} }),
        () => Promise.resolve(toolMessage),
      )

      expect(response).toBe(toolMessage)
    })

    it('passes a Command response through without recording a result or an ERROR status', async () => {
      const wrapToolCall = defaultToolCallMiddleware()
      // wrapToolCall's handler may return ToolMessage | Command, but only
      // the ToolMessage branch is inspected (see genai-tracing-middleware.ts's
      // ToolMessage.isInstance check), so a bare non-ToolMessage stand-in
      // exercises the passthrough branch without depending on
      // @langchain/langgraph's Command class directly.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- deliberately a non-ToolMessage stand-in for Command (see comment above)
      const command = { lg_name: 'Command' } as unknown as Awaited<
        ReturnType<WrapToolCall>
      >

      const response = await wrapToolCall(
        fakeToolCallRequest({ name: 'get_weather', args: {} }),
        () => Promise.resolve(command),
      )

      expect(response).toBe(command)
      expect(await collectSpans()).toEqual([
        {
          name: 'execute_tool get_weather',
          kind: SpanKind.INTERNAL,
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': 'get_weather',
          },
          statusCode: SpanStatusCode.UNSET,
        },
      ])
    })

    // context.with() puts the span in the active context for the call's
    // duration, so any span the handler creates (e.g. an HTTP span from the
    // tool's implementation) nests under it as a child.
    it("runs the handler inside the tool span's active context, so a span created during the call becomes its child", async () => {
      const wrapToolCall = defaultToolCallMiddleware()

      await wrapToolCall(
        fakeToolCallRequest({ name: 'get_weather', args: {} }),
        () => {
          trace.getTracer('test').startSpan('GET').end()
          return Promise.resolve(
            new ToolMessage({ content: 'ok', tool_call_id: 'call_1' }),
          )
        },
      )

      const spans = spanExporter.getFinishedSpans()
      const toolSpan = spans.find((s) => s.name === 'execute_tool get_weather')
      const httpSpan = spans.find((s) => s.name === 'GET')
      if (toolSpan === undefined || httpSpan === undefined) {
        throw new Error(
          'expected both the tool span and the HTTP span to be recorded',
        )
      }
      expect(httpSpan.parentSpanContext?.spanId).toBe(
        toolSpan.spanContext().spanId,
      )
    })

    it('rethrows the error the tool handler throws', async () => {
      const wrapToolCall = defaultToolCallMiddleware()
      const error = new Error('tool execution failed')

      await expect(
        wrapToolCall(
          fakeToolCallRequest({ name: 'get_weather', args: {} }),
          () => {
            throw error
          },
        ),
      ).rejects.toBe(error)
    })

    it('records an ERROR span when the handler throws', async () => {
      const wrapToolCall = defaultToolCallMiddleware()

      try {
        await wrapToolCall(
          fakeToolCallRequest({ name: 'get_weather', args: {} }),
          () => {
            throw new Error('tool execution failed')
          },
        )
      } catch {
        // asserted by the 'rethrows the error the tool handler throws' test above
      }

      expect(await collectSpans()).toEqual([
        {
          name: 'execute_tool get_weather',
          kind: SpanKind.INTERNAL,
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': 'get_weather',
          },
          statusCode: SpanStatusCode.ERROR,
        },
      ])
    })

    it("records an ERROR span when the handler returns a ToolMessage with status 'error'", async () => {
      const wrapToolCall = defaultToolCallMiddleware()

      await wrapToolCall(
        fakeToolCallRequest({ name: 'get_weather', args: {} }),
        () =>
          Promise.resolve(
            new ToolMessage({
              content: 'city not found',
              tool_call_id: 'call_1',
              status: 'error',
            }),
          ),
      )

      expect(await collectSpans()).toEqual([
        {
          name: 'execute_tool get_weather',
          kind: SpanKind.INTERNAL,
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': 'get_weather',
          },
          statusCode: SpanStatusCode.ERROR,
        },
      ])
    })

    it('omits tool call arguments and result by default', async () => {
      const wrapToolCall = defaultToolCallMiddleware()

      await wrapToolCall(
        fakeToolCallRequest({
          id: 'call_1',
          name: 'get_weather',
          args: { city: 'Tokyo' },
        }),
        () =>
          Promise.resolve(
            new ToolMessage({
              content: '{"temperature":21}',
              tool_call_id: 'call_1',
            }),
          ),
      )

      expect(await collectSpans()).toEqual([
        {
          name: 'execute_tool get_weather',
          kind: SpanKind.INTERNAL,
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': 'get_weather',
            'gen_ai.tool.call.id': 'call_1',
          },
          statusCode: SpanStatusCode.UNSET,
        },
      ])
    })

    it('captures tool call arguments and result when opted in', async () => {
      const wrapToolCall = capturingToolCallMiddleware()

      await wrapToolCall(
        fakeToolCallRequest({
          id: 'call_1',
          name: 'get_weather',
          args: { city: 'Tokyo' },
        }),
        () =>
          Promise.resolve(
            new ToolMessage({
              content: '{"temperature":21}',
              tool_call_id: 'call_1',
            }),
          ),
      )

      expect(await collectSpans()).toEqual([
        {
          name: 'execute_tool get_weather',
          kind: SpanKind.INTERNAL,
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': 'get_weather',
            'gen_ai.tool.call.id': 'call_1',
            'gen_ai.tool.call.arguments': JSON.stringify({ city: 'Tokyo' }),
            'gen_ai.tool.call.result': '{"temperature":21}',
          },
          statusCode: SpanStatusCode.UNSET,
        },
      ])
    })
  })
})
