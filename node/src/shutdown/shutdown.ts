import { ResultAsync } from 'neverthrow'

import { ownSignals } from '../signal-owner'

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

  const onSignal = (signal: NodeJS.Signals): void => {
    // logger/exit are caller-supplied; a throw from either must not surface
    // as an unhandled rejection and crash the process before later steps
    // (e.g. closing a DB pool) get to run.
    shutdown(signal).catch(() => {})
  }

  const shutdown = (signal = 'manual'): Promise<void> => {
    if (shutdownPromise) return shutdownPromise
    // Detach the listeners on first shutdown so a second createShutdownHandler
    // call in the same process is not eclipsed by a stale listener.
    detach()

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

  const { detach } = ownSignals(onSignal)

  return { shutdown }
}
