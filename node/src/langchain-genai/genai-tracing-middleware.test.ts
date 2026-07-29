import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages'
import type { Attributes } from '@opentelemetry/api'
import { context, SpanStatusCode, trace } from '@opentelemetry/api'
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
})
