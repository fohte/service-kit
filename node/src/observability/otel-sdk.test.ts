import { afterEach, describe, expect, it, vi } from 'vitest'

import { createMetricViews, createNodeSdk } from '#observability/otel'

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

    expect(nodeSdkConstructorMock.mock.calls[0]?.[0]).toEqual(
      createMetricViews(),
    )
  })
})
