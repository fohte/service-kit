# Logger conventions

Audience: implementers of the kit, and operators who integrate it into a service.

Conventions for the structured-logging layer shared by `@fohte/service-kit` (Node) and `fohte-service-kit` (Rust crate). Treat this document as the source of truth: when the Node or Rust implementation changes, update both implementations and this document in the same PR.

## Design policy

### Scope: leveled, structured log lines — not tracing

The module produces the human/machine log line a service writes for a single event (`logger.info({ userId }, 'user created')`). Spans, metrics, and error reporting are [`observability`](./observability.md)'s job; this module never talks to OTel or Sentry directly.

### Secret redaction shares one pattern list with `observability`

Key-based redaction reuses `DEFAULT_SECRET_KEY_PATTERNS` from `@fohte/service-kit/observability` instead of keeping a second list of secret-like key names in sync by hand. Redaction matches by key name at any depth in the logged fields (not by an enumerated path list), so a new nested field named `api_key` is redacted without any caller changes.

### Callers inject config, they don't rely on ambient env reads

`createLogger` never reads `process.env` itself — `level`, `pretty`, and `base` are explicit options, matching `@fohte/service-kit/env`'s "inject the source" policy. Pair it with the `env` module to source `LOG_LEVEL` and `NODE_ENV`.

### The `Logger` interface is implementation-independent

`Logger` is a small interface (six leveled methods plus `child`), not the underlying logging library's own type. Callers can implement it with a fake in tests, and it stays stable if the Node implementation swaps its underlying library later.

## Node

### API

```ts
import { createLogger } from '@fohte/service-kit/logger'
import { optionalEnum } from '@fohte/service-kit/env'

const LOG_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
]

const logger = createLogger({
  level: optionalEnum(process.env, 'LOG_LEVEL', LOG_LEVELS, 'info').unwrapOr(
    'info',
  ),
  pretty: process.env['NODE_ENV'] === 'development',
  base: { service: 'my-service' },
})

logger.info({ userId: 'U1' }, 'user created')

const requestLogger = logger.child({ requestId: 'r1' })
requestLogger.warn({ status: 429 }, 'rate limited')
```

### Options

| Option                   | Type                      | Purpose                                                                                                                                    |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `level`                  | `LogLevel`                | Minimum level emitted. Defaults to `'info'`.                                                                                               |
| `base`                   | `Record<string, unknown>` | Fields merged into every log line (e.g. `{ service: 'my-service' }`). Omitted fields are not added — there is no default `pid`/`hostname`. |
| `pretty`                 | `boolean`                 | Human-readable colorized output instead of NDJSON. Defaults to `false`; ignored when `destination` is set.                                 |
| `destination`            | `pino.DestinationStream`  | Custom write target, e.g. a buffer in tests. Disables `pretty` (the two are mutually exclusive in the underlying implementation).          |
| `extraSecretKeyPatterns` | `ReadonlyArray<RegExp>`   | Additional key-name patterns to redact, alongside `DEFAULT_SECRET_KEY_PATTERNS`.                                                           |

### `Logger` interface

`trace` / `debug` / `info` / `warn` / `error` / `fatal` each take `(fields, message)`, both required — every log line carries both a human message and structured fields, even if `fields` is `{}`. `child(bindings)` returns a new `Logger` that includes `bindings` (redacted the same way as any other fields) on every subsequent call.

`Logger.info`/`Logger.warn` are structurally compatible with `ObservabilityLogger` from `@fohte/service-kit/observability`, so a logger created here can be passed directly as `initObservability`'s `logger` option.

### `noopLogger`

A `Logger` whose methods do nothing and whose `child()` returns itself. Use it as a default for an optional `logger` parameter in library code, the same way `retry`'s `onRetry` or `observability`'s `logger` option default to a no-op.

### Dependencies

The underlying implementation (`pino`, and `pino-pretty` for the `pretty` option) is only needed by services that import `@fohte/service-kit/logger`, so both are declared as `peerDependencies` with `peerDependenciesMeta.optional`, the same pattern used for the heavy OTel/Sentry SDKs in `observability`.

## Rust

`fohte_service_kit::logging` (see [observability conventions](./observability.md#rust)) already provides env-driven, JSONL structured logging with daily rotation. It does not yet redact secret-like fields, and its API does not mirror the Node `Logger` interface above. Reconciling the two (shared redact patterns, an equivalent interface) is future work, not required by this document today.
