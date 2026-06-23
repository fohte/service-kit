import { describe, expect, it } from 'vitest'

import { createNodeSdk, isOtelConfigured } from '@/observability/otel'

describe('isOtelConfigured', () => {
  it('returns true when the endpoint is set', () => {
    expect(
      isOtelConfigured({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example/',
      }),
    ).toBe(true)
  })

  it('returns false when the endpoint is missing', () => {
    expect(isOtelConfigured({})).toBe(false)
  })

  it('returns false when the endpoint is blank', () => {
    expect(isOtelConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' })).toBe(false)
  })

  it('ignores OTEL_EXPORTER_OTLP_HEADERS when deciding configuration', () => {
    expect(
      isOtelConfigured({
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic abc',
      }),
    ).toBe(false)
  })
})

describe('createNodeSdk', () => {
  it('throws when OTEL_EXPORTER_OTLP_ENDPOINT is missing or blank', () => {
    expect(() => createNodeSdk({ env: {} })).toThrow(
      /OTEL_EXPORTER_OTLP_ENDPOINT is required/,
    )
    expect(() =>
      createNodeSdk({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: '   ' } }),
    ).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT is required/)
  })

  it('throws when no service name can be resolved from env or defaultServiceName', () => {
    expect(() =>
      createNodeSdk({
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example/' },
      }),
    ).toThrow(/OTEL_SERVICE_NAME/)
  })
})
