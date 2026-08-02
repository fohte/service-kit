# LangChain GenAI conventions

Audience: implementers of the kit, and operators who integrate it into a service.

Conventions for the LangChain agent tracing layer of `@fohte/service-kit` (Node). Treat this document as the source of truth: when the implementation changes, update both the implementation and this document in the same PR.

## Design policy

### Middleware, not a callback handler

`createGenAiTracingMiddleware` is a LangChain agent middleware (`wrapModelCall` and `wrapToolCall` hooks), not a callback handler. Wrapping the model/tool call itself keeps the span active in context for the call's duration, so any span created during the call (e.g. an HTTP instrumentation span for the underlying fetch) nests under it as a child rather than landing as an unrelated sibling — a callback handler's separate start/end hooks can't provide that nesting.

### One `execute_tool` span per tool call

`wrapToolCall` starts one INTERNAL span per tool invocation (name: `execute_tool {gen_ai.tool.name}`, per the GenAI semantic conventions' span-naming rule), distinct from `wrapModelCall`'s CLIENT chat span because tool execution runs in-process rather than calling out to the GenAI provider. This gives per-tool-call nodes in observability backends that infer an agent graph from span parent/child relationships (e.g. Langfuse's Agent Graph), which a `tool_call` part embedded inside a chat span's `gen_ai.output.messages` can't provide on its own. The chat span's `tool_call` / `tool_call_response` parts are kept regardless — the GenAI semantic conventions define both the message parts and the `execute_tool` span, and Langfuse's Agent Graph needs the latter, not a replacement for the former.

### Message content capture is opt-in

`gen_ai.input.messages` / `gen_ai.output.messages` (on the chat span) and `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` (on the `execute_tool` span) may contain PII, so they're only recorded when explicitly enabled (`captureMessageContent: true` or `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`), mirroring the opt-in capture convention of other OpenTelemetry GenAI instrumentations. Every other `gen_ai.*` attribute (model, provider, usage, finish reason, tool name/type/id/description) is always recorded.

### System prompt and reasoning content live outside `request.messages` / `message.content`

LangChain's agent runtime carries the system prompt on a separate `request.systemMessage` field, and some providers return reasoning content on `additional_kwargs.reasoning_content` rather than `message.content`. Both are still part of what the model actually saw or produced, so they're folded into `gen_ai.input.messages` / `gen_ai.output.messages` (system prompt as the first input message, reasoning as the first part of the output message) instead of being silently dropped.

## Node

### API

`@fohte/service-kit/langchain-genai` exports `createGenAiTracingMiddleware`.

```ts
import { createAgent } from 'langchain'
import { createGenAiTracingMiddleware } from '@fohte/service-kit/langchain-genai'

const agent = createAgent({
  model,
  middleware: [createGenAiTracingMiddleware({ providerName: 'openai' })],
})
```

`createGenAiTracingMiddleware(options)` returns a LangChain agent middleware whose `wrapModelCall` hook starts one CLIENT span per model inference call (name: `chat {model}`, following the GenAI semantic conventions' `{gen_ai.operation.name} {gen_ai.request.model}` span-naming rule), records `gen_ai.*` attributes (operation name, provider, request/response model, usage tokens, finish reason), sets the span to `ERROR` status and records the exception if the call throws, and always ends the span.

Its `wrapToolCall` hook starts one INTERNAL span per tool call (name: `execute_tool {tool name}`), records `gen_ai.*` attributes (operation name, tool name, tool type, and — when available — tool call id and tool description), sets the span to `ERROR` status if the call throws (recording the exception) or if the handler returns a `ToolMessage` with `status: 'error'`, and always ends the span. A handler-returned `Command` is passed through without inspection: attaching a result to the span isn't supported for that return type.

### Registering this middleware disables `ToolNode`'s tool-error recovery

LangChain's `ToolNode` (the tool-execution node `createAgent` builds internally) catches a thrown tool error and converts it into an error `ToolMessage`, letting the agent turn continue so the model can see the error and retry. That conversion applies only to errors it catches directly from tool execution, though: once _any_ middleware in `createAgent`'s `middleware` array defines a `wrapToolCall` hook — this one does — a caught error is instead attributed to middleware and, unless `ToolNode`'s `handleToolErrors` option is set to the literal `true`, is re-thrown instead of converted, failing the whole agent turn (`node_modules/langchain/dist/agents/nodes/ToolNode.cjs`, `runTool` / `#handleError`). `createAgent`'s `tools` option only accepts `(ServerTool | ClientTool)[]` (`node_modules/langchain/dist/agents/types.d.cts`), with no parameter that reaches `handleToolErrors` — so adding `createGenAiTracingMiddleware` to `middleware` is enough, on its own, to turn every tool call that can throw (e.g. a delegation tool or an MCP tool making a network call) from recoverable into turn-failing.

This is a LangChain-level effect of registering any `wrapToolCall` middleware, not something specific to tracing, and recovering from a tool error is a separate responsibility from tracing it (see "Middleware, not a callback handler" above) — so this middleware does not work around it. Add LangChain's own `toolErrorMiddleware` (exported from `langchain` since 1.5.4; not present in earlier 1.5.x releases) to the `middleware` array to restore the recovery behavior:

```ts
import { createAgent, toolErrorMiddleware } from 'langchain'
import { createGenAiTracingMiddleware } from '@fohte/service-kit/langchain-genai'

const agent = createAgent({
  model,
  middleware: [
    createGenAiTracingMiddleware({ providerName: 'openai' }),
    toolErrorMiddleware({
      onError: (error) =>
        `${error instanceof Error ? error.message : String(error)}\n Please fix your mistakes.`,
    }),
  ],
})
```

Order matters: LangChain composes `wrapToolCall` hooks with the first middleware in the array as the outermost layer, so `createGenAiTracingMiddleware` must come before `toolErrorMiddleware` for its `wrapToolCall` to see the `ToolMessage` (`status: 'error'`) that `toolErrorMiddleware` converts the thrown error into, and report it as `ERROR` on the `execute_tool` span per the behavior described above.

### Options

| Option                  | Type                                            | Purpose                                                                                   |
| ----------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `providerName`          | `string`                                        | Value for `gen_ai.provider.name` (e.g. `'openai'`).                                       |
| `captureMessageContent` | `boolean`                                       | Record `gen_ai.input.messages` / `gen_ai.output.messages`. Defaults to the env var below. |
| `env`                   | `Readonly<Record<string, string \| undefined>>` | Env source read for the default of `captureMessageContent`. Defaults to `process.env`.    |

`captureMessageContent` defaults to reading `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` from `env` (or `process.env`) and treating the string `'true'` as enabled.

### Dependencies

`langchain` and `@langchain/core` are only needed by services that import `@fohte/service-kit/langchain-genai`, so both are declared as `peerDependencies` with `peerDependenciesMeta.optional`, the same pattern used for the OTel/Sentry SDKs in `observability` and for `pino` in `logger`.

## Rust

Not applicable: LangChain is a JavaScript/TypeScript library with no equivalent in the Rust crate's dependency surface, so this module has no Rust counterpart.
