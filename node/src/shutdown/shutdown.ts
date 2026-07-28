import { ResultAsync } from 'neverthrow'

export interface ShutdownStep {
  readonly name: string
  readonly run: () => Promise<void> | void
}

export interface ShutdownLogger {
  info(payload: Record<string, unknown>, msg: string): void
  warn(payload: Record<string, unknown>, msg: string): void
}

export interface ShutdownHandle {
  readonly shutdown: (signal?: string) => Promise<void>
}

export interface CreateShutdownHandlerOptions {
  readonly logger?: ShutdownLogger | undefined
  readonly exit?: ((code: number) => void) | undefined
}

const noopLogger: ShutdownLogger = {
  info: () => {},
  warn: () => {},
}

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error))

// Steps run strictly in registration order (drain in-flight work, then close
// the HTTP server, then close DB pools, ...), since later steps often assume
// an earlier one already completed. A failing step is logged and does not
// block the rest: leaving a later resource (e.g. a DB pool) open because an
// earlier drain errored would be worse than a partial cleanup.
export const createShutdownHandler = (
  steps: readonly ShutdownStep[],
  options: CreateShutdownHandlerOptions = {},
): ShutdownHandle => {
  const logger = options.logger ?? noopLogger
  const exit = options.exit ?? ((code: number) => process.exit(code))

  let shutdownPromise: Promise<void> | undefined
  // `onSignal` closes over the per-instance `shutdown`. Register listeners
  // before defining `shutdown` so the cleanup inside `shutdown` can `off`
  // the same function reference.
  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal)
  }

  const shutdown = (signal = 'manual'): Promise<void> => {
    if (shutdownPromise) return shutdownPromise
    // Detach the listeners on first shutdown so a second createShutdownHandler
    // call in the same process is not eclipsed by a stale listener.
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)

    shutdownPromise = (async () => {
      logger.info(
        {
          event: 'shutdown_initiated',
          signal,
          steps: steps.map((step) => step.name),
        },
        'shutdown signal received; running shutdown steps',
      )

      let hadError = false
      for (const step of steps) {
        const result = await ResultAsync.fromPromise(
          Promise.resolve().then(() => step.run()),
          toError,
        )
        if (result.isErr()) {
          hadError = true
          logger.warn(
            {
              event: 'shutdown_step_failed',
              step: step.name,
              error: result.error.message,
            },
            'shutdown step failed',
          )
        }
      }

      logger.info(
        { event: 'shutdown_completed', signal, hadError },
        'shutdown steps complete; exiting',
      )
      exit(hadError ? 1 : 0)
    })()
    return shutdownPromise
  }

  // Use `once` (not `on`) so a second delivery after the listener has
  // detached itself falls through to Node's default handler.
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)

  return { shutdown }
}
