import * as Sentry from '@sentry/node'
import { SentryPropagator } from '@sentry/opentelemetry'

import {
  createNodeSdk,
  isOtelConfigured,
  type OtelEnv,
  type OtelOptions,
} from '@/observability/otel'
import {
  initSentry,
  type InitSentryOptions,
  isSentryConfigured,
  type SentryEnv,
} from '@/observability/sentry'

export interface ObservabilityEnv extends OtelEnv, SentryEnv {}

export interface ObservabilityHandle {
  readonly shutdown: () => Promise<void>
}

export interface ObservabilityLogger {
  info(payload: Record<string, unknown>, msg: string): void
  warn(payload: Record<string, unknown>, msg: string): void
}

export interface InitObservabilityOptions extends InitSentryOptions {
  readonly logger?: ObservabilityLogger | undefined
  readonly defaultServiceName?: string | undefined
  readonly extraSpanProcessors?: OtelOptions['spanProcessors'] | undefined
  readonly sampler?: OtelOptions['sampler'] | undefined
  readonly shutdownTimeoutMs?: number | undefined
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000

const noopLogger: ObservabilityLogger = {
  info: () => {},
  warn: () => {},
}

const noopHandle: ObservabilityHandle = { shutdown: async () => {} }

const flushAndLog = (
  otelSdk: { shutdown(): Promise<unknown> } | undefined,
  sentryStarted: boolean,
  shutdownTimeoutMs: number,
  logger: ObservabilityLogger,
): Promise<void> =>
  Promise.allSettled([
    otelSdk ? otelSdk.shutdown() : Promise.resolve(),
    sentryStarted ? Sentry.close(shutdownTimeoutMs) : Promise.resolve(),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') {
        const reason: unknown = result.reason
        logger.warn(
          {
            event: 'observability_shutdown_failed',
            error: reason instanceof Error ? reason.message : String(reason),
          },
          'observability shutdown error',
        )
      }
    }
  })

export const initObservability = (
  env: ObservabilityEnv,
  options: InitObservabilityOptions = {},
): ObservabilityHandle => {
  const {
    logger = noopLogger,
    defaultServiceName,
    extraSpanProcessors,
    sampler,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    ...sentryOpts
  } = options
  const otel = isOtelConfigured(env)
  const sentry = isSentryConfigured(env)

  let sentryStarted = false
  let otelSdk: ReturnType<typeof createNodeSdk> | undefined

  try {
    if (sentry) {
      initSentry(env, sentryOpts)
      sentryStarted = true
    }

    if (otel) {
      otelSdk = createNodeSdk({
        env,
        ...(defaultServiceName !== undefined ? { defaultServiceName } : {}),
        ...(sampler ? { sampler } : {}),
        ...(extraSpanProcessors ? { spanProcessors: extraSpanProcessors } : {}),
        // Sentry's autocapture inherits the trace_id from the active OTel span
        // when we hand OTel Sentry's propagator and context manager. Skip the
        // wiring entirely when Sentry is not enabled so the OTel SDK falls
        // back to the default W3C propagator and async-hooks context manager.
        ...(sentryStarted
          ? {
              propagator: new SentryPropagator(),
              contextManager: new Sentry.SentryContextManager(),
            }
          : {}),
      })
      otelSdk.start()
      // Run Sentry's self-diagnostic only when both SDKs are wired together,
      // since it inspects the OTel context manager / propagator that we just
      // installed.
      if (sentryStarted) {
        Sentry.validateOpenTelemetrySetup()
      }
    }

    logger.info(
      { event: 'observability_initialized', otel, sentry },
      'observability initialized',
    )

    if (!sentryStarted && otelSdk === undefined) return noopHandle

    let shutdownPromise: Promise<void> | undefined
    const shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise
      shutdownPromise = flushAndLog(
        otelSdk,
        sentryStarted,
        shutdownTimeoutMs,
        logger,
      )
      return shutdownPromise
    }

    // Registering a custom listener for SIGTERM/SIGINT suppresses Node's
    // default termination, so re-send the signal after shutdown completes —
    // the `once` listener has already removed itself, so the second delivery
    // triggers the default behavior.
    const onSignal = (signal: NodeJS.Signals): void => {
      void shutdown().then(() => {
        process.kill(process.pid, signal)
      })
    }
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)

    return { shutdown }
  } catch (err) {
    logger.warn(
      {
        event: 'observability_init_failed',
        error: err instanceof Error ? err.message : String(err),
      },
      'failed to initialize observability',
    )
    // Hold the cleanup promise on the returned handle so the caller can still
    // `await handle.shutdown()` to wait for the in-flight flush before exit,
    // instead of losing the very telemetry that exposed the init failure.
    const cleanup = flushAndLog(
      otelSdk,
      sentryStarted,
      shutdownTimeoutMs,
      logger,
    )
    return { shutdown: () => cleanup }
  }
}
