# Observability conventions

Audience: implementers of the kit, and operators who integrate it into a service.

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

| Variable                             | Required | Purpose                                                                                                                                                                                                                                                                 |
| ------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`        | yes\*    | OTLP exporter base URL. The signal path (`/v1/traces`) is appended automatically, matching the OTLP spec. Set the base URL (e.g. `https://otlp-gateway-prod-ap-northeast-0.grafana.net/otlp`) — do not include `/v1/traces` yourself, or the collector will return 404. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | yes\*    | Traces-specific override used verbatim. Prefer this over `OTEL_EXPORTER_OTLP_ENDPOINT` when the backend expects a fully-qualified traces URL. \*Either this or `OTEL_EXPORTER_OTLP_ENDPOINT` is required.                                                               |
| `OTEL_EXPORTER_OTLP_HEADERS`         | yes      | OTLP auth headers shared by all signals (e.g. `Authorization=Basic ...`)                                                                                                                                                                                                |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS`  | no       | Traces-specific header override used verbatim when set, fully replacing `OTEL_EXPORTER_OTLP_HEADERS` (per the OTLP spec's "takes precedence" wording — signal-specific keys are not merged with generic ones).                                                          |
| `OTEL_SERVICE_NAME`                  | yes      | Same value as the `service.name` resource attribute                                                                                                                                                                                                                     |
| `OTEL_RESOURCE_ATTRIBUTES`           | no       | Additional resource attributes (e.g. `deployment.environment=production`)                                                                                                                                                                                               |
| `SENTRY_DSN`                         | yes      | Sentry project DSN                                                                                                                                                                                                                                                      |
| `SENTRY_ENVIRONMENT`                 | yes      | Sentry environment (e.g. `production`, `staging`)                                                                                                                                                                                                                       |
| `SENTRY_RELEASE`                     | no       | Release identifier (e.g. git commit SHA), injected from CI                                                                                                                                                                                                              |

All `OTEL_*` variables follow the OpenTelemetry standard ([OpenTelemetry Environment Variable Specification](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/), [OTLP exporter spec](https://opentelemetry.io/docs/specs/otel/protocol/exporter/)). The library introduces no custom prefix.

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

`@fohte/service-kit/observability` exports `initObservability` as the entry point integrators are expected to call, plus the low-level building blocks (`createNodeSdk`, `initSentry`, `redactEvent`, `captureWithFingerprint`) used to assemble it.

```ts
import { initObservability } from '@fohte/service-kit/observability'

const observability = initObservability(process.env, {
  // optional extensions
})
// SIGTERM / SIGINT handlers that flush both SDKs and re-deliver the signal
// are installed by `initObservability` itself — the integrator does not need
// to wire them. Call `observability.shutdown()` directly for non-signal exits.
```

`initObservability(env, options)` does the following:

1. Read `env`. Fail fast (throw) if neither Sentry nor OpenTelemetry is configured — provide dummy values in development if telemetry is intentionally disabled. Use `isObservabilityConfigured(env)` to probe the env before calling.
2. Treat each SDK independently: only Sentry is initialized when just `SENTRY_*` is set, only OTel is started when just `OTEL_*` is set, and both run when both are set.
3. If Sentry is configured, initialize Sentry first so its global hooks are in place before OTel starts.
4. If OTel is configured, build `NodeSDK`. When Sentry is also enabled, register `SentryPropagator` and `SentryContextManager`. Call `start()`.
5. If both SDKs are enabled, call `Sentry.validateOpenTelemetrySetup()` to confirm the wiring.
6. Register per-instance SIGTERM / SIGINT handlers that flush both SDKs and re-deliver the signal so Node's default termination still runs. The listeners detach themselves on first `shutdown()` call so a subsequent `initObservability` in the same process re-registers fresh handlers.
7. Return a handle with a `shutdown()` method. `shutdown()` is idempotent and runs `Promise.allSettled([sdk.shutdown(), Sentry.close(timeoutMs)])`.
8. If initialization throws after a partial start, log an `observability_init_failed` warn event, kick off a best-effort flush of whichever SDK had already started, and re-throw so the caller fails fast.

### Options

| Option                   | Type                                            | Purpose                                                                               |
| ------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `logger`                 | `{ info(payload, msg); warn(payload, msg) }`    | Logger to record init / shutdown events. Defaults to a no-op.                         |
| `defaultServiceName`     | `string`                                        | Fallback `service.name` used when neither env var carries one.                        |
| `extraSecretKeyPatterns` | `RegExp[]`                                      | Additional key patterns to redact on top of the defaults (see Redact patterns above). |
| `extraStringTruncators`  | `Array<{ pattern: RegExp; maxLength: number }>` | Truncate string values whose key matches `pattern` to `maxLength` characters.         |
| `extraSpanProcessors`    | `SpanProcessor[]`                               | Additional span processors to register on the OTel SDK.                               |
| `sampler`                | `Sampler`                                       | Override the OTel sampler. Defaults to the SDK's standard sampler.                    |
| `extraIgnoreErrors`      | `Array<string \| RegExp>`                       | Additional `ignoreErrors` patterns forwarded to Sentry on top of the noise defaults.  |
| `sentryOptions`          | `Partial<Sentry.NodeOptions>`                   | Extra options forwarded to `Sentry.init` (e.g. `tracesSampleRate`).                   |
| `shutdownTimeoutMs`      | `number`                                        | Per-SDK timeout passed to `Sentry.close`. Defaults to 5000 ms.                        |

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
