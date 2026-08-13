import * as Sentry from '@sentry/node'

import { BoundaryError } from '../errors'
import { ownSignals } from '../signal-owner'
import {
  createNodeSdk,
  isOtelConfigured,
  type OtelEnv,
  type OtelOptions,
} from './otel'
import {
  initSentry,
  type InitSentryOptions,
  isSentryConfigured,
  type SentryEnv,
} from './sentry'

export class ObservabilityInitError extends BoundaryError {}

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
  readonly registerSignalHandlers?: boolean | undefined
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
    registerSignalHandlers = true,
    ...sentryOpts
  } = options
  const otel = isOtelConfigured(env)
  const sentry = isSentryConfigured(env)

  if (!otel && !sentry) {
    // eslint-disable-next-line no-restricted-syntax -- initObservability's public contract is to throw synchronously when required config is missing
    throw new Error(
      'Observability is not configured. At least one of Sentry (SENTRY_DSN) or OpenTelemetry (OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) must be configured. Provide dummy values in development if you do not want to ship telemetry.',
    )
  }

  let sentryStarted = false
  let otelSdk: ReturnType<typeof createNodeSdk> | undefined

  // eslint-disable-next-line no-restricted-syntax -- best-effort cleanup before rethrowing, per initObservability's throw-based contract
  try {
    if (sentry) {
      initSentry(env, {
        ...sentryOpts,
        sentryOptions: {
          // Disable Sentry's own `traceparent` injection whenever OTel is
          // also configured: OTel's undici/http instrumentation injects it
          // instead, and having both enabled double-injects the header (see
          // `initSentry`'s `propagateTraceparent` comment for the failure
          // mode). Caller-supplied `sentryOptions.propagateTraceparent`
          // still wins if explicitly set.
          propagateTraceparent: !otel,
          ...sentryOpts.sentryOptions,
        },
      })
      sentryStarted = true
    }

    if (otel) {
      otelSdk = createNodeSdk({
        env,
        ...(defaultServiceName !== undefined ? { defaultServiceName } : {}),
        ...(sampler ? { sampler } : {}),
        ...(extraSpanProcessors ? { spanProcessors: extraSpanProcessors } : {}),
        // Keep OTel's default W3C `traceparent` propagator even when Sentry
        // is enabled: `SentryPropagator.extract()` only reads `sentry-trace`
        // and silently drops an incoming `traceparent`, breaking distributed
        // tracing against services that don't ship spans to Sentry.
        // `SentryContextManager` only syncs Sentry's scope with the local
        // OTel context (unrelated to wire propagation), so it still wires up
        // whenever Sentry is enabled.
        ...(sentryStarted
          ? { contextManager: new Sentry.SentryContextManager() }
          : {}),
      })
      otelSdk.start()
      // Run Sentry's self-diagnostic only when both SDKs are wired together,
      // since it inspects the OTel context manager we just installed. It
      // always flags the propagator as missing too, since we deliberately
      // don't install `SentryPropagator` — expected noise.
      if (sentryStarted) {
        Sentry.validateOpenTelemetrySetup()
      }
    }

    logger.info(
      { event: 'observability_initialized', otel, sentry },
      'observability initialized',
    )

    let shutdownPromise: Promise<void> | undefined
    const onSignal = (signal: NodeJS.Signals): void => {
      // Sentry/OTel shutdown and the logger are outside our control; a
      // rejection here must not surface as an unhandled rejection.
      shutdown()
        .finally(() => {
          process.kill(process.pid, signal)
        })
        .catch(() => {})
    }
    const shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise
      // Detach the listeners on first shutdown so the closure (otelSdk,
      // logger, etc.) can be released and a second initObservability call
      // in the same process is not eclipsed by a stale listener.
      detachSignals()
      shutdownPromise = flushAndLog(
        otelSdk,
        sentryStarted,
        shutdownTimeoutMs,
        logger,
      )
      return shutdownPromise
    }
    // Skip when a caller composes shutdown via
    // `@fohte/service-kit/shutdown`, which owns process signal registration
    // for the whole service; pass `shutdown` to it as one of its steps
    // instead of registering a second, competing SIGTERM/SIGINT listener.
    const detachSignals = registerSignalHandlers
      ? ownSignals(onSignal).detach
      : () => {}

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
    // eslint-disable-next-line no-restricted-syntax -- interop boundary: wrap and rethrow after best-effort cleanup, per initObservability's throw-based contract
    throw new ObservabilityInitError('failed to initialize observability', err)
  }
}

export const initObservabilityIfConfigured = (
  env: ObservabilityEnv,
  options?: InitObservabilityOptions,
): ObservabilityHandle | undefined =>
  isObservabilityConfigured(env) ? initObservability(env, options) : undefined
