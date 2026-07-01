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

export const isObservabilityConfigured = (env: ObservabilityEnv): boolean =>
  isOtelConfigured(env) || isSentryConfigured(env)

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

  if (!otel && !sentry) {
    throw new Error(
      'Observability is not configured. At least one of Sentry (SENTRY_DSN) or OpenTelemetry (OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) must be configured. Provide dummy values in development if you do not want to ship telemetry.',
    )
  }

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
        // Fall back to the OTel defaults (W3C propagator + async-hooks
        // context manager) when Sentry is disabled — handing OTel a
        // `SentryPropagator` / `SentryContextManager` without a live Sentry
        // hub would attach them to nothing and lose trace context entirely.
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

    let shutdownPromise: Promise<void> | undefined
    // `onSignal` closes over the per-instance `shutdown`. Register listeners
    // before defining `shutdown` so the cleanup inside `shutdown` can `off`
    // the same function reference.
    const onSignal = (signal: NodeJS.Signals): void => {
      void shutdown().finally(() => {
        process.kill(process.pid, signal)
      })
    }
    const shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise
      // Detach the listeners on first shutdown so the closure (otelSdk,
      // logger, etc.) can be released and a second initObservability call
      // in the same process is not eclipsed by a stale listener.
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
      shutdownPromise = flushAndLog(
        otelSdk,
        sentryStarted,
        shutdownTimeoutMs,
        logger,
      )
      return shutdownPromise
    }
    // Use `once` (not `on`) so a second delivery after the listener has
    // detached itself falls through to Node's default handler.
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
    // Best-effort flush of whichever SDK already started before re-throwing,
    // so the warn above (and any in-flight telemetry) is not lost to the
    // process exiting on the propagated error.
    void flushAndLog(otelSdk, sentryStarted, shutdownTimeoutMs, logger)
    throw err
  }
}
