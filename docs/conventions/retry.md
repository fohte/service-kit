# Retry conventions

Audience: implementers of the kit, and operators who integrate it into a service.

Conventions for the retry layer shared by `@fohte/service-kit` (Node) and `fohte-service-kit` (Rust crate). Treat this document as the source of truth: when the Node or Rust implementation changes, update both implementations and this document in the same PR.

## Design policy

### Scope: sleep + exponential backoff only

The module wraps the one recurring pattern found across services: a `sleep()` primitive plus an exponential-backoff retry loop around a single fallible operation. Rate limiting, circuit breaking, and HTTP client wrappers are out of scope — each service's client already has its own transport (octokit, a chat SDK, bare `fetch`, ...), and a general abstraction over that layer doesn't hold up across them.

### Callers decide what's retryable

The retry loop itself doesn't inspect error types. Callers pass a predicate to opt specific errors in or out of retrying (e.g. HTTP 5xx retryable, 4xx not); the default predicate retries every error. Backoff delay and attempt count are surfaced through a callback hook instead of a built-in logger, since each service already has its own logger type and log field conventions.

## Node

### API

`@fohte/service-kit/retry` exports `retry` (an exponential-backoff wrapper around a `ResultAsync`-returning operation) and `sleep` (the underlying delay primitive, usable standalone for a one-off wait that doesn't need a full backoff loop).

```ts
import { retry } from '@fohte/service-kit/retry'

const result = await retry(() => fetchSomething(), {
  maxRetries: 3,
  initialDelayMs: 100,
  shouldRetry: (error) => error.retryable,
  onRetry: ({ attempt, delayMs, error }) => {
    logger.warn({ attempt, delayMs, err: error }, 'retrying')
  },
})
```

`retry(fn, options)` calls `fn()` and, on `Err`, retries with delay `initialDelayMs * 2 ** attempt` (0-indexed) until either `fn()` resolves `Ok` or `maxRetries` is exhausted. The original error is returned unwrapped on exhaustion — wrap it in a domain-specific error via `.mapErr()` if the caller needs one.

### Options

| Option           | Type                                                             | Purpose                                                                                  |
| ---------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `maxRetries`     | `number`                                                         | Maximum number of retries after the first attempt. Defaults to 3.                        |
| `initialDelayMs` | `number`                                                         | Delay before the first retry; doubles on each subsequent retry. Defaults to 100.         |
| `shouldRetry`    | `(error: E) => boolean`                                          | Predicate deciding whether a given error is retryable. Defaults to retrying every error. |
| `onRetry`        | `(info: { attempt: number; delayMs: number; error: E }) => void` | Called right before each retry's delay. Use it to log or record metrics.                 |

## Rust

The Rust implementation will come later. Concrete API names will be appended to this document at implementation time. The intended shape mirrors the Node API: a `sleep` primitive and a `retry` combinator around a `Result`-returning closure, with the retry predicate and attempt hook supplied by the caller.

Until the crate exists, this section is a policy statement for how Rust will satisfy the language-agnostic conventions (scope, retry-predicate ownership, backoff formula).
