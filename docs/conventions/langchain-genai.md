# LangChain GenAI conventions

Audience: implementers of the kit, and operators who integrate it into a service.

Conventions for the LangChain agent tracing layer of `@fohte/service-kit` (Node). Treat this document as the source of truth: when the implementation changes, update both the implementation and this document in the same PR.

## Design policy

### Middleware, not a callback handler

`createGenAiTracingMiddleware` is a LangChain agent middleware (a `wrapModelCall` hook), not a callback handler. Wrapping the model call itself keeps the span active in context for the call's duration, so any span created during the call (e.g. an HTTP instrumentation span for the underlying fetch) nests under it as a child rather than landing as an unrelated sibling — a callback handler's separate start/end hooks can't provide that nesting.

### Message content capture is opt-in

`gen_ai.input.messages` / `gen_ai.output.messages` may contain PII, so they're only recorded when explicitly enabled (`captureMessageContent: true` or `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`), mirroring the opt-in capture convention of other OpenTelemetry GenAI instrumentations. Every other `gen_ai.*` attribute (model, provider, usage, finish reason) is always recorded.

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
