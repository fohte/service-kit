import { describe, expect, it } from 'vitest'

import {
  createNodeSdk,
  isOtelConfigured,
  resolveTracesEndpoint,
} from '@/observability/otel'

describe('isOtelConfigured', () => {
  it('returns true when the base endpoint is set', () => {
    expect(
      isOtelConfigured({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example/',
      }),
    ).toBe(true)
  })

  it('returns true when only the traces-specific endpoint is set', () => {
    expect(
      isOtelConfigured({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://otlp.example/v1/traces',
      }),
    ).toBe(true)
  })

  it('returns false when neither endpoint is set', () => {
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

describe('resolveTracesEndpoint', () => {
  it.each([
    {
      name: 'root base URL',
      base: 'https://otlp.example',
      expected: 'https://otlp.example/v1/traces',
    },
    {
      name: 'base URL with a path prefix (Grafana Cloud gateway shape)',
      base: 'https://otlp-gateway-prod-ap-northeast-0.grafana.net/otlp',
      expected:
        'https://otlp-gateway-prod-ap-northeast-0.grafana.net/otlp/v1/traces',
    },
  ])('appends /v1/traces to $name', ({ base, expected }) => {
    expect(resolveTracesEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: base })).toBe(
      expected,
    )
  })

  it('strips trailing slashes before joining the signal path', () => {
    expect(
      resolveTracesEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example///',
      }),
    ).toBe('https://otlp.example/v1/traces')
  })

  it('uses the traces-specific endpoint verbatim when set, ignoring the base endpoint', () => {
    expect(
      resolveTracesEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ignored.example/otlp',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
          'https://otlp.example/custom/path/v1/traces',
      }),
    ).toBe('https://otlp.example/custom/path/v1/traces')
  })

  it('returns an empty string when no endpoint is configured', () => {
    expect(resolveTracesEndpoint({})).toBe('')
  })
})

describe('createNodeSdk', () => {
  const MISSING_ENDPOINT_MESSAGE =
    'OTEL_EXPORTER_OTLP_ENDPOINT (or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) is required to build the OpenTelemetry SDK. Provide a dummy endpoint in development if you do not have an OTLP collector configured.'
  const MISSING_SERVICE_NAME_MESSAGE =
    'OTEL_SERVICE_NAME (or `service.name` in OTEL_RESOURCE_ATTRIBUTES, or the `defaultServiceName` option) is required to build the OpenTelemetry SDK.'

  it('throws when no endpoint env var is set', () => {
    expect(() => createNodeSdk({ env: {} })).toThrow(
      new Error(MISSING_ENDPOINT_MESSAGE),
    )
  })

  it('throws when the endpoint env var is blank', () => {
    expect(() =>
      createNodeSdk({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: '   ' } }),
    ).toThrow(new Error(MISSING_ENDPOINT_MESSAGE))
  })

  it('throws when no service name can be resolved from env or defaultServiceName', () => {
    expect(() =>
      createNodeSdk({
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example/' },
      }),
    ).toThrow(new Error(MISSING_SERVICE_NAME_MESSAGE))
  })
})
