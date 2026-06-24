import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OtelOptions } from '@/observability/otel'

// Stub @sentry/node and @sentry/opentelemetry: the real SDKs install global
// instrumentation hooks on import that we don't want to run inside the test
// process. Stubbing also lets us observe the call sequence (initSentry →
// sdk.start → validateOpenTelemetrySetup).
const {
  sentryInit,
  sentryClose,
  sentryValidate,
  FakeSentryContextManager,
  FakeSentryPropagator,
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
  FakeSentryPropagator: class {
    readonly _kind = 'SentryPropagator' as const
  },
  sdkStart: vi.fn<() => void>(),
  sdkShutdown: vi.fn<() => Promise<void>>(),
  createNodeSdkMock:
    vi.fn<
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

vi.mock('@sentry/opentelemetry', () => ({
  SentryPropagator: FakeSentryPropagator,
}))

vi.mock('@/observability/otel', async () => {
  const actual = await vi.importActual<typeof import('@/observability/otel')>(
    '@/observability/otel',
  )
  return {
    ...actual,
    createNodeSdk: createNodeSdkMock,
  }
})

const { initObservability } = await import('@/observability/init')

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

    const sdkOptions = createNodeSdkMock.mock.calls[0]?.[0]
    // Normalize the raw invocationCallOrder values (which jitter with the
    // shared vitest counter) to a dense rank so the call sequence is a stable
    // literal: rank 1 = first call, 2 = next call, etc.
    const rankCallOrder = (mock: { invocationCallOrder: number[] }): number => {
      const order = [
        sentryInit.mock.invocationCallOrder[0] ?? -1,
        createNodeSdkMock.mock.invocationCallOrder[0] ?? -1,
        sdkStart.mock.invocationCallOrder[0] ?? -1,
        sentryValidate.mock.invocationCallOrder[0] ?? -1,
      ]
        .filter((n) => n > 0)
        .sort((a, b) => a - b)
      const self = mock.invocationCallOrder[0] ?? -1
      return order.indexOf(self) + 1
    }
    expect({
      sentryInitCount: sentryInit.mock.calls.length,
      createNodeSdkCount: createNodeSdkMock.mock.calls.length,
      sdkStartCount: sdkStart.mock.calls.length,
      validateCount: sentryValidate.mock.calls.length,
      callOrder: {
        sentryInit: rankCallOrder(sentryInit.mock),
        createNodeSdk: rankCallOrder(createNodeSdkMock.mock),
        sdkStart: rankCallOrder(sdkStart.mock),
        sentryValidate: rankCallOrder(sentryValidate.mock),
      },
      propagator: sdkOptions?.propagator instanceof FakeSentryPropagator,
      contextManager:
        sdkOptions?.contextManager instanceof FakeSentryContextManager,
      hasShutdown: typeof handle.shutdown === 'function',
      infoCalls: logger.info.mock.calls,
      warnCalls: logger.warn.mock.calls,
    }).toEqual({
      sentryInitCount: 1,
      createNodeSdkCount: 1,
      sdkStartCount: 1,
      validateCount: 1,
      callOrder: {
        sentryInit: 1,
        createNodeSdk: 2,
        sdkStart: 3,
        sentryValidate: 4,
      },
      propagator: true,
      contextManager: true,
      hasShutdown: true,
      infoCalls: [
        [
          { event: 'observability_initialized', otel: true, sentry: true },
          'observability initialized',
        ],
      ],
      warnCalls: [],
    })
  })

  it('initializes Sentry only when OTel is not configured', () => {
    const logger = makeLogger()
    const env = {
      SENTRY_DSN: FULL_ENV.SENTRY_DSN,
      SENTRY_ENVIRONMENT: FULL_ENV.SENTRY_ENVIRONMENT,
    }
    const handle = initObservability(env, { logger })

    expect({
      sentryInitCount: sentryInit.mock.calls.length,
      createNodeSdkCount: createNodeSdkMock.mock.calls.length,
      sdkStartCount: sdkStart.mock.calls.length,
      validateCount: sentryValidate.mock.calls.length,
      hasShutdown: typeof handle.shutdown === 'function',
      infoCalls: logger.info.mock.calls,
      warnCalls: logger.warn.mock.calls,
    }).toEqual({
      sentryInitCount: 1,
      createNodeSdkCount: 0,
      sdkStartCount: 0,
      validateCount: 0,
      hasShutdown: true,
      infoCalls: [
        [
          { event: 'observability_initialized', otel: false, sentry: true },
          'observability initialized',
        ],
      ],
      warnCalls: [],
    })
  })

  it('initializes OTel only and skips the Sentry self-diagnostic when Sentry is not configured', () => {
    const logger = makeLogger()
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: FULL_ENV.OTEL_EXPORTER_OTLP_ENDPOINT,
      OTEL_SERVICE_NAME: FULL_ENV.OTEL_SERVICE_NAME,
    }
    const handle = initObservability(env, { logger })

    const sdkOptions = createNodeSdkMock.mock.calls[0]?.[0]
    expect({
      sentryInitCount: sentryInit.mock.calls.length,
      createNodeSdkCount: createNodeSdkMock.mock.calls.length,
      sdkStartCount: sdkStart.mock.calls.length,
      validateCount: sentryValidate.mock.calls.length,
      propagator: sdkOptions?.propagator,
      contextManager: sdkOptions?.contextManager,
      hasShutdown: typeof handle.shutdown === 'function',
      infoCalls: logger.info.mock.calls,
      warnCalls: logger.warn.mock.calls,
    }).toEqual({
      sentryInitCount: 0,
      createNodeSdkCount: 1,
      sdkStartCount: 1,
      validateCount: 0,
      propagator: undefined,
      contextManager: undefined,
      hasShutdown: true,
      infoCalls: [
        [
          { event: 'observability_initialized', otel: true, sentry: false },
          'observability initialized',
        ],
      ],
      warnCalls: [],
    })
  })

  it('returns a no-op handle and logs only the init event when neither is configured', async () => {
    const logger = makeLogger()
    const handle = initObservability({}, { logger })
    await handle.shutdown()

    expect({
      sentryInitCount: sentryInit.mock.calls.length,
      createNodeSdkCount: createNodeSdkMock.mock.calls.length,
      sdkShutdownCount: sdkShutdown.mock.calls.length,
      sentryCloseCount: sentryClose.mock.calls.length,
      infoCalls: logger.info.mock.calls,
      warnCalls: logger.warn.mock.calls,
    }).toEqual({
      sentryInitCount: 0,
      createNodeSdkCount: 0,
      sdkShutdownCount: 0,
      sentryCloseCount: 0,
      infoCalls: [
        [
          { event: 'observability_initialized', otel: false, sentry: false },
          'observability initialized',
        ],
      ],
      warnCalls: [],
    })
  })

  it('runs the underlying shutdown only once across repeated calls', async () => {
    const handle = initObservability(FULL_ENV)
    const first = handle.shutdown()
    const second = handle.shutdown()
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ])
    await expect(handle.shutdown()).resolves.toBeUndefined()

    expect({
      sameReference: first === second,
      sdkShutdownCount: sdkShutdown.mock.calls.length,
      sentryCloseCount: sentryClose.mock.calls.length,
    }).toEqual({
      sameReference: true,
      sdkShutdownCount: 1,
      sentryCloseCount: 1,
    })
  })

  it('logs a warn event and returns a no-op handle when initialization throws', async () => {
    const logger = makeLogger()
    const boom = new Error('boom: sdk.start failed')
    sdkStart.mockImplementationOnce(() => {
      throw boom
    })

    const handle = initObservability(FULL_ENV, { logger })
    await handle.shutdown()

    expect({
      sentryValidateCount: sentryValidate.mock.calls.length,
      infoCalls: logger.info.mock.calls,
      warnCalls: logger.warn.mock.calls,
    }).toEqual({
      sentryValidateCount: 0,
      infoCalls: [],
      warnCalls: [
        [
          {
            event: 'observability_init_failed',
            error: 'boom: sdk.start failed',
          },
          'failed to initialize observability',
        ],
      ],
    })
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
