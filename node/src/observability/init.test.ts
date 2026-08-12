import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OtelOptions } from '#observability/otel'

// Stub @sentry/node: the real SDK installs global instrumentation hooks on
// import that we don't want to run inside the test process. Stubbing also
// lets us observe the call sequence (initSentry → sdk.start →
// validateOpenTelemetrySetup).
const {
  sentryInit,
  sentryClose,
  sentryValidate,
  FakeSentryContextManager,
  sdkStart,
  sdkShutdown,
  createNodeSdkMock,
} = vi.hoisted(() => ({
  sentryInit: vi.fn(),
  sentryClose: vi.fn(),
  sentryValidate: vi.fn(),
  FakeSentryContextManager: class {
    readonly _kind = 'SentryContextManager' as const
  },
  sdkStart: vi.fn<() => void>(),
  sdkShutdown: vi.fn<() => Promise<void>>(),
  createNodeSdkMock: vi.fn<
    (options: OtelOptions) => {
      start: () => void
      shutdown: () => Promise<void>
    }
  >(),
}))

vi.mock('@sentry/node', () => ({
  init: sentryInit,
  close: sentryClose,
  validateOpenTelemetrySetup: sentryValidate,
  SentryContextManager: FakeSentryContextManager,
}))

vi.mock('#observability/otel', async () => {
  const actual = await vi.importActual<typeof import('#observability/otel')>(
    '#observability/otel',
  )
  return {
    ...actual,
    createNodeSdk: createNodeSdkMock,
  }
})

const {
  initObservability,
  initObservabilityIfConfigured,
  ObservabilityInitError,
} = await import('#observability/init')

const FULL_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example/',
  OTEL_SERVICE_NAME: 'test-service',
  SENTRY_DSN: 'https://abc@sentry.example/1',
  SENTRY_ENVIRONMENT: 'test',
} as const

interface MockLogger {
  info: ReturnType<
    typeof vi.fn<(payload: Record<string, unknown>, msg: string) => void>
  >
  warn: ReturnType<
    typeof vi.fn<(payload: Record<string, unknown>, msg: string) => void>
  >
}

const makeLogger = (): MockLogger => ({
  info: vi.fn<(payload: Record<string, unknown>, msg: string) => void>(),
  warn: vi.fn<(payload: Record<string, unknown>, msg: string) => void>(),
})

beforeEach(() => {
  sentryInit.mockReset().mockReturnValue({})
  sentryClose.mockReset().mockResolvedValue(true)
  sentryValidate.mockReset()
  sdkStart.mockReset()
  sdkShutdown.mockReset().mockResolvedValue(undefined)
  createNodeSdkMock
    .mockReset()
    .mockReturnValue({ start: sdkStart, shutdown: sdkShutdown })
})

afterEach(() => {
  process.removeAllListeners('SIGTERM')
  process.removeAllListeners('SIGINT')
})

describe('initObservability', () => {
  it('starts Sentry then OTel and runs the Sentry self-diagnostic when both are configured', () => {
    const logger = makeLogger()
    const handle = initObservability(FULL_ENV, { logger })

    expect(sentryInit).toHaveBeenCalledTimes(1)
    expect(createNodeSdkMock).toHaveBeenCalledTimes(1)
    expect(sdkStart).toHaveBeenCalledTimes(1)
    expect(sentryValidate).toHaveBeenCalledTimes(1)

    const sdkOptions = createNodeSdkMock.mock.calls[0]?.[0]
    expect(sdkOptions).toEqual({
      env: FULL_ENV,
      contextManager: { _kind: 'SentryContextManager' },
    })

    const callOrder = [
      sentryInit.mock.invocationCallOrder[0],
      createNodeSdkMock.mock.invocationCallOrder[0],
      sdkStart.mock.invocationCallOrder[0],
      sentryValidate.mock.invocationCallOrder[0],
    ]
    expect(callOrder.every((n): n is number => typeof n === 'number')).toBe(
      true,
    )
    expect([...callOrder].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      callOrder,
    )

    expect(handle.shutdown).toBeInstanceOf(Function)
    expect(logger.info.mock.calls).toEqual([
      [
        { event: 'observability_initialized', otel: true, sentry: true },
        'observability initialized',
      ],
    ])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('initializes Sentry only when OTel is not configured', () => {
    const logger = makeLogger()
    const env = {
      SENTRY_DSN: FULL_ENV.SENTRY_DSN,
      SENTRY_ENVIRONMENT: FULL_ENV.SENTRY_ENVIRONMENT,
    }
    const handle = initObservability(env, { logger })

    expect(sentryInit).toHaveBeenCalledTimes(1)
    expect(createNodeSdkMock).not.toHaveBeenCalled()
    expect(sdkStart).not.toHaveBeenCalled()
    expect(sentryValidate).not.toHaveBeenCalled()
    expect(handle.shutdown).toBeInstanceOf(Function)
    expect(logger.info.mock.calls).toEqual([
      [
        { event: 'observability_initialized', otel: false, sentry: true },
        'observability initialized',
      ],
    ])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('initializes OTel only and skips the Sentry self-diagnostic when Sentry is not configured', () => {
    const logger = makeLogger()
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: FULL_ENV.OTEL_EXPORTER_OTLP_ENDPOINT,
      OTEL_SERVICE_NAME: FULL_ENV.OTEL_SERVICE_NAME,
    }
    const handle = initObservability(env, { logger })

    expect(sentryInit).not.toHaveBeenCalled()
    expect(createNodeSdkMock).toHaveBeenCalledTimes(1)
    expect(sdkStart).toHaveBeenCalledTimes(1)
    expect(sentryValidate).not.toHaveBeenCalled()

    const sdkOptions = createNodeSdkMock.mock.calls[0]?.[0]
    expect(sdkOptions?.propagator).toBeUndefined()
    expect(sdkOptions?.contextManager).toBeUndefined()

    expect(handle.shutdown).toBeInstanceOf(Function)
    expect(logger.info.mock.calls).toEqual([
      [
        { event: 'observability_initialized', otel: true, sentry: false },
        'observability initialized',
      ],
    ])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('throws when neither Sentry nor OpenTelemetry is configured', () => {
    const logger = makeLogger()

    expect(() => initObservability({}, { logger })).toThrow(
      /Observability is not configured/,
    )
    expect(sentryInit).not.toHaveBeenCalled()
    expect(createNodeSdkMock).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('runs the underlying shutdown only once across repeated calls', async () => {
    const handle = initObservability(FULL_ENV)
    await Promise.all([handle.shutdown(), handle.shutdown()])
    await handle.shutdown()

    expect(sdkShutdown).toHaveBeenCalledTimes(1)
    expect(sentryClose).toHaveBeenCalledTimes(1)
  })

  it('detaches its signal listeners on shutdown so a second init re-registers fresh handlers', async () => {
    const before = process.listenerCount('SIGTERM')
    const first = initObservability(FULL_ENV)
    expect(process.listenerCount('SIGTERM')).toBe(before + 1)
    await first.shutdown()
    expect(process.listenerCount('SIGTERM')).toBe(before)

    const second = initObservability(FULL_ENV)
    expect(process.listenerCount('SIGTERM')).toBe(before + 1)
    await second.shutdown()
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })

  it('does not register signal handlers when registerSignalHandlers is false', () => {
    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    }

    initObservability(FULL_ENV, { registerSignalHandlers: false })

    expect({
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    }).toEqual(before)
  })

  it('still flushes both SDKs via shutdown() when registerSignalHandlers is false', async () => {
    const handle = initObservability(FULL_ENV, {
      registerSignalHandlers: false,
    })

    await handle.shutdown()

    expect(sdkShutdown).toHaveBeenCalledTimes(1)
    expect(sentryClose).toHaveBeenCalledTimes(1)
  })

  it('does not produce an unhandled rejection when a signal-triggered shutdown fails', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    sdkShutdown.mockRejectedValueOnce(new Error('flush failed'))
    const logger = makeLogger()
    logger.warn.mockImplementationOnce(() => {
      throw new Error('logger boom')
    })
    initObservability(FULL_ENV, { logger })

    const unhandled = vi.fn()
    process.once('unhandledRejection', unhandled)
    process.emit('SIGTERM', 'SIGTERM')
    await new Promise((resolve) => setImmediate(resolve))
    process.off('unhandledRejection', unhandled)
    killSpy.mockRestore()

    expect(unhandled).not.toHaveBeenCalled()
  })

  it('wraps the failure in ObservabilityInitError, logs a warn event, and rethrows', () => {
    const logger = makeLogger()
    const boom = new Error('boom: sdk.start failed')
    sdkStart.mockImplementationOnce(() => {
      throw boom
    })

    let thrown: unknown
    try {
      initObservability(FULL_ENV, { logger })
    } catch (err) {
      thrown = err
    }

    if (!(thrown instanceof ObservabilityInitError)) {
      throw new Error(
        'expected initObservability to throw ObservabilityInitError',
      )
    }
    expect({
      name: thrown.name,
      message: thrown.message,
      cause: thrown.cause,
    }).toEqual({
      name: 'ObservabilityInitError',
      message: 'failed to initialize observability',
      cause: boom,
    })
    expect(sentryValidate).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.warn.mock.calls).toEqual([
      [
        {
          event: 'observability_init_failed',
          error: 'boom: sdk.start failed',
        },
        'failed to initialize observability',
      ],
    ])
  })

  it('only emits the booleans / event name in the init log payload — never DSN or OTLP endpoint', () => {
    const logger = makeLogger()
    initObservability(FULL_ENV, { logger })

    expect(logger.info.mock.calls).toEqual([
      [
        { event: 'observability_initialized', otel: true, sentry: true },
        'observability initialized',
      ],
    ])
  })
})

describe('initObservabilityIfConfigured', () => {
  it('delegates to initObservability and returns its handle when configured', () => {
    const logger = makeLogger()
    const handle = initObservabilityIfConfigured(FULL_ENV, { logger })

    expect(handle?.shutdown).toBeInstanceOf(Function)
  })

  it('returns undefined without initializing anything when not configured', () => {
    const logger = makeLogger()
    const handle = initObservabilityIfConfigured({}, { logger })

    expect(handle).toBeUndefined()
    expect(sentryInit).not.toHaveBeenCalled()
    expect(createNodeSdkMock).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
