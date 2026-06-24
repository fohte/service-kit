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

// `initObservability` installs SIGTERM/SIGINT once for the process lifetime —
// a repeated call (e.g. in tests or a hot-reload loop) must not stack a second
// pair of listeners that would each re-deliver the signal.
let signalsInstalled = false

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

    if (!signalsInstalled) {
      // Re-send the signal after shutdown so Node's default termination
      // still runs. `finally` (not `then`) so a throwing logger inside
      // `flushAndLog` still lets the signal reach the default handler.
      const onSignal = (signal: NodeJS.Signals): void => {
        void shutdown().finally(() => {
          process.kill(process.pid, signal)
        })
      }
      process.once('SIGTERM', onSignal)
      process.once('SIGINT', onSignal)
      signalsInstalled = true
    }

    return { shutdown }
  } catch (err) {
    logger.warn(
      {
        event: 'observability_init_failed',
        error: err instanceof Error ? err.message : String(err),
      },
      'failed to initialize observability',
    )
    // Lazy cleanup: defer the flush until the caller actually invokes
    // `shutdown()`. Kicking off Promise.allSettled here would either run
    // unobserved (silent telemetry loss) or surface as an unhandled
    // rejection if the caller exits without awaiting the handle.
    let lazyCleanup: Promise<void> | undefined
    return {
      shutdown: () => {
        if (!lazyCleanup) {
          lazyCleanup = flushAndLog(
            otelSdk,
            sentryStarted,
            shutdownTimeoutMs,
            logger,
          )
        }
        return lazyCleanup
      },
    }
  }
}
