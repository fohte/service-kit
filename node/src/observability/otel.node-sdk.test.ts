import { AggregationType } from '@opentelemetry/sdk-metrics'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createNodeSdk } from '#observability/otel'

// Keep this test separate because its NodeSDK mock is file-scoped.
const { nodeSdkConstructorMock } = vi.hoisted(() => ({
  nodeSdkConstructorMock: vi.fn<(views: unknown) => void>(),
}))

vi.mock('@opentelemetry/sdk-node', () => {
  function NodeSDK(options: { readonly views?: unknown }) {
    nodeSdkConstructorMock(options.views)
  }

  return { NodeSDK }
})

afterEach(() => {
  nodeSdkConstructorMock.mockReset()
})

describe('createNodeSdk', () => {
  it('passes the metric views to NodeSDK', () => {
    createNodeSdk({
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example' },
      defaultServiceName: 'test-service',
    })

    expect(nodeSdkConstructorMock.mock.calls).toEqual([
      [
        [
          {
            meterName: '@opentelemetry/instrumentation-http',
            aggregation: { type: AggregationType.DROP },
          },
          {
            meterName: '@opentelemetry/instrumentation-undici',
            aggregation: { type: AggregationType.DROP },
          },
          {
            instrumentName: 'v8js.gc.duration',
            aggregation: { type: AggregationType.DROP },
          },
        ],
      ],
    ])
  })
})
