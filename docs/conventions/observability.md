# Observability conventions

Conventions for the observability layer shared by `@fohte/service-kit` (Node) and `fohte-service-kit` (Rust crate). Treat this document as the source of truth: when the Node or Rust implementation changes, update both implementations and this document in the same PR.

## Design policy

### Separate span and error responsibilities

- Span / metric / log: send via the OpenTelemetry SDK to an OTLP-compatible backend.
- Error event: send to Sentry (via `Sentry.captureException`, or by letting the Sentry SDK pick up unhandled exceptions).
- Do not double-send spans to Sentry. Specifically, do not register `SentrySpanProcessor` or `SentrySampler`.
- The Sentry SDK is wired into OpenTelemetry only for trace-context propagation (register `SentryPropagator` and `SentryContextManager` on the OTel SDK).

This way the Sentry event quota is consumed by error events only.

## Environment variables

Every service reads the following environment variables. Values are expected to be injected by the operator's secret-delivery mechanism; the library itself ships no defaults.

| Variable                      | Required | Purpose                                                                   |
| ----------------------------- | -------- | ------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | yes      | OTLP exporter endpoint URL                                                |
| `OTEL_EXPORTER_OTLP_HEADERS`  | yes      | OTLP auth headers (e.g. `Authorization=Basic ...`)                        |
| `OTEL_SERVICE_NAME`           | yes      | Same value as the `service.name` resource attribute                       |
| `OTEL_RESOURCE_ATTRIBUTES`    | no       | Additional resource attributes (e.g. `deployment.environment=production`) |
| `SENTRY_DSN`                  | yes      | Sentry project DSN                                                        |
| `SENTRY_ENVIRONMENT`          | yes      | Sentry environment (e.g. `production`, `staging`)                         |
| `SENTRY_RELEASE`              | no       | Release identifier (e.g. git commit SHA), injected from CI                |

All `OTEL_*` variables follow the OpenTelemetry standard ([OpenTelemetry Environment Variable Specification](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/)). The library introduces no custom prefix.

## Redact patterns

The library's default redactor masks sensitive values in logs, span attributes, and Sentry events by the following rules.

- Mask the value when the key name matches one of the following case-insensitive regexes. Each pattern anchors on a word boundary so a bare key like `token` or `dsn` matches too:
  - `/(?:^|_)TOKEN$/i` (e.g. `token`, `SLACK_BOT_TOKEN`, `github_token`)
  - `/(?:^|_)DSN$/i` (e.g. `dsn`, `SENTRY_DSN`, `database_dsn`)
  - `/(?:^|_)API_KEY$/i` (e.g. `api_key`, `OPENAI_API_KEY`)
- Mask the value of the HTTP header `Authorization` (case-insensitive).

The masked value is replaced by the literal `[REDACTED]`. Services can extend the patterns through options.

## Resource attributes

The OTel resource carries the following attributes.

| Attribute                | Required | Example                                  |
| ------------------------ | -------- | ---------------------------------------- |
| `service.name`           | yes      | Same value as `OTEL_SERVICE_NAME`        |
| `deployment.environment` | no       | `production` / `staging` / `development` |

If `service.name` is missing, the library fails fast at init.

## Startup order

Initialize the observability layer in this order during service bootstrap.

1. **Sentry init**: call `Sentry.init({ dsn, environment, release, ... })` first. The Sentry SDK installs global hooks that must be in place before the OTel SDK starts.
2. **Build the OTel SDK**: construct `NodeSDK` (Node) or `opentelemetry::sdk` (Rust). Register only `SentryPropagator` and `SentryContextManager` as the Sentry integration — do not add any Sentry-derived span processor or sampler.
3. **`sdk.start()`**: start the OTel SDK.
4. **`Sentry.validateOpenTelemetrySetup()`**: run Sentry's self-diagnostic to confirm the OTel wiring matches expectations.

Breaking this order disables Sentry's trace correlation or causes spans to be double-sent.

## Shutdown order

On SIGTERM / SIGINT, flush both SDKs concurrently.

```ts
await Promise.allSettled([sdk.shutdown(), Sentry.close(timeoutMs)])
```

- Run concurrently: a slow flush on one side must not block the other.
- Use `Promise.allSettled`: keep waiting for the other side even if one rejects.
- Be idempotent: a duplicate SIGTERM must return safely as a no-op (guard with an `alreadyShuttingDown` flag).
- Pass a sensible timeout (e.g. 5 seconds) to each SDK so shutdown cannot hang indefinitely.

On the Rust side, `Drop` is synchronous (Rust has no async `Drop`), so Sentry's `ClientInitGuard` cannot be flushed inside `tokio::join!`. Await the OTel exporter's async flush first, then drop the guard (either by letting it leave scope or by calling `drop(guard)` explicitly) so its blocking flush runs last.

## Node

### API

`@fohte/service-kit/observability` exports a single entry point, `initObservability`.

```ts
import { initObservability } from '@fohte/service-kit/observability'

const observability = initObservability(process.env, {
  // optional extensions
})

process.on('SIGTERM', () => observability.shutdown())
process.on('SIGINT', () => observability.shutdown())
```

`initObservability(env, options)` does the following:

1. Read `env` and fail fast if any required variable is missing.
2. Initialize Sentry.
3. Build `NodeSDK`, register `SentryPropagator` and `SentryContextManager`, and call `start()`.
4. Call `Sentry.validateOpenTelemetrySetup()`.
5. Return a handle with a `shutdown()` method. `shutdown()` is idempotent and runs `Promise.allSettled([sdk.shutdown(), Sentry.close(5000)])`.

### Options

| Option                   | Type                                            | Purpose                                                                               |
| ------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `extraSecretKeyPatterns` | `RegExp[]`                                      | Additional key patterns to redact on top of the defaults (see Redact patterns above). |
| `extraStringTruncators`  | `Array<{ pattern: RegExp; maxLength: number }>` | Truncate string values whose key matches `pattern` to `maxLength` characters.         |
| `extraSpanProcessors`    | `SpanProcessor[]`                               | Additional span processors to register on the OTel SDK.                               |
| `extraInstrumentations`  | `Instrumentation[]`                             | Additional auto-instrumentations.                                                     |
| `sentryOptions`          | `Partial<Sentry.NodeOptions>`                   | Extra options forwarded to `Sentry.init` (e.g. `tracesSampleRate`).                   |

A service-specific rule such as "truncate the body of a chat message to 200 characters" is expressible through options alone, without modifying the library:

```ts
initObservability(process.env, {
  extraStringTruncators: [
    { pattern: /^chat\.message\.body$/i, maxLength: 200 },
  ],
})
```

### Dependencies

`@sentry/node` and the `@opentelemetry/*` packages are heavy, so they are declared as `peerDependencies` with `peerDependenciesMeta.optional`. Consumers install the versions they need directly, keeping `@fohte/service-kit` itself thin.

## Rust

The Rust implementation will come later. Concrete API names will be appended to this document at implementation time. The intended stack is:

- `tracing` + `tracing-subscriber` as the surface API for logs and spans.
- `opentelemetry` + `opentelemetry-otlp` to send to the OTLP exporter.
- The `sentry` crate (`sentry-rust`) for error reporting, with `sentry-tracing` bridging `tracing`'s `event::ERROR` to Sentry.
- The same span/error split as on the Node side — spans are not double-sent to Sentry; only trace-context propagation crosses the boundary.

Until the crate exists, this section is a policy statement for how Rust will satisfy the language-agnostic conventions (environment variables, redact patterns, startup order, shutdown order).
