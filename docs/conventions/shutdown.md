# Shutdown conventions

Audience: implementers of the kit, and operators who integrate it into a service.

Conventions for the graceful-shutdown layer shared by `@fohte/service-kit` (Node) and `fohte-service-kit` (Rust crate). Treat this document as the source of truth: when the Node or Rust implementation changes, update both implementations and this document in the same PR.

## Design policy

### One process, one signal owner

A service registers exactly one SIGTERM/SIGINT listener for its whole shutdown sequence. Two independent listeners (e.g. one draining an in-flight-task queue, another flushing observability) fire concurrently on the same signal delivery with no ordering guarantee between them, which is exactly the failure mode this module exists to prevent. `createShutdownHandler` owns that single listener; other components (notably `@fohte/service-kit/observability`) opt out of registering their own via a constructor option and instead participate as an ordered step.

### Steps run in order, best-effort

Callers pass an ordered list of named steps (e.g. drain in-flight work, close the HTTP server, close a DB pool, flush observability last). Steps run strictly in registration order, since a later step's precondition is often "the previous one already finished" (a DB pool must outlive the in-flight requests it backs). A step that throws is logged and does not stop the remaining steps: leaving a later resource open because an earlier step errored is worse than a partial cleanup. The process exits non-zero if any step failed, zero otherwise.

## Node

### API

`@fohte/service-kit/shutdown` exports `createShutdownHandler`.

```ts
import { createShutdownHandler } from '@fohte/service-kit/shutdown'

createShutdownHandler([
  { name: 'drain', run: () => inFlightTasks.waitForIdle() },
  {
    name: 'close-server',
    run: () => new Promise((resolve) => server.close(() => resolve())),
  },
  { name: 'close-db-pool', run: () => pool.end() },
])
```

`createShutdownHandler(steps, options)` registers SIGTERM/SIGINT listeners that, on first delivery: log `shutdown_initiated`, run each step in order (logging `shutdown_step_failed` and continuing past a failing step instead of aborting), log `shutdown_completed` with whether any step failed, then call `exit(0)` (or `exit(1)` if any step failed). The listeners detach themselves on the first shutdown so a later `createShutdownHandler` call in the same process re-registers fresh handlers. The returned `shutdown(signal?)` is idempotent (repeated calls return the same in-flight/completed promise) and can be called directly for a non-signal exit; `signal` defaults to `'manual'` in that case.

### Options

| Option   | Type                                         | Purpose                                                                |
| -------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| `logger` | `{ info(payload, msg); warn(payload, msg) }` | Logger to record shutdown lifecycle events. Defaults to a no-op.       |
| `exit`   | `(code: number) => void`                     | Process-exit function. Defaults to `process.exit`. Override for tests. |

### Composing with `observability`

`initObservability` registers its own SIGTERM/SIGINT listener by default (see [observability conventions](./observability.md)) so it keeps working standalone. To compose it under a single shutdown owner, pass `registerSignalHandlers: false` to `initObservability` and include its `shutdown` as the last step, so telemetry flushes only after app-level cleanup has finished:

```ts
const observability = initObservability(process.env, {
  registerSignalHandlers: false,
})

createShutdownHandler([
  { name: 'drain', run: () => inFlightTasks.waitForIdle() },
  {
    name: 'close-server',
    run: () => new Promise((resolve) => server.close(() => resolve())),
  },
  { name: 'observability', run: () => observability.shutdown() },
])
```

A service with no app-level resources to drain (e.g. a bare webhook receiver) still gets a working SIGTERM/SIGINT handler from `createShutdownHandler([])` alone, without depending on `observability` at all.

## Rust

The Rust implementation will come later. Concrete API names will be appended to this document at implementation time. The intended shape mirrors the Node API: an ordered list of named async cleanup steps run under a single signal handler, with the Sentry/OTel flush (see the Rust subsection of [observability conventions](./observability.md)) composed in as the last step.

Until the crate exists, this section is a policy statement for how Rust will satisfy the language-agnostic conventions (single signal owner, ordered best-effort steps).
