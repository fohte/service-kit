import type { ContextManager, TextMapPropagator } from '@opentelemetry/api'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import type { Resource } from '@opentelemetry/resources'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeSDK } from '@opentelemetry/sdk-node'
import type { Sampler, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

export interface OtelEnv {
  readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined
  readonly OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string | undefined
  readonly OTEL_EXPORTER_OTLP_HEADERS?: string | undefined
  readonly OTEL_EXPORTER_OTLP_TRACES_HEADERS?: string | undefined
  readonly OTEL_SERVICE_NAME?: string | undefined
  readonly OTEL_RESOURCE_ATTRIBUTES?: string | undefined
}

export interface OtelOptions {
  readonly env: OtelEnv
  readonly defaultServiceName?: string | undefined
  readonly sampler?: Sampler | undefined
  readonly spanProcessors?: readonly SpanProcessor[] | undefined
  readonly propagator?: TextMapPropagator | undefined
  readonly contextManager?: ContextManager | undefined
}

const readBaseEndpoint = (env: OtelEnv): string =>
  env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ?? ''

// Per the OTLP exporter spec, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is used
// verbatim while `OTEL_EXPORTER_OTLP_ENDPOINT` is a base URL that has the
// signal path (`/v1/traces`) appended. Passing a base URL as `url` verbatim
// (the SDK's default when `url` is set explicitly) makes collectors return
// 404 and silently drops every span, so we join the signal path here.
// Signal-specific takes precedence even when set to an empty string — that
// case falls through the trim to `''` and triggers `createNodeSdk`'s
// missing-endpoint throw rather than silently using the base URL.
// https://opentelemetry.io/docs/specs/otel/protocol/exporter/
export const resolveTracesEndpoint = (env: OtelEnv): string => {
  if (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT !== undefined) {
    return env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT.trim()
  }
  const base = readBaseEndpoint(env)
  if (base.length === 0) return ''
  return `${base.replace(/\/+$/, '')}/v1/traces`
}

export const isOtelConfigured = (env: OtelEnv): boolean =>
  resolveTracesEndpoint(env).length > 0

const safeDecode = (raw: string): string => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

// Parses `key1=value1,key2=value2` per the W3C Baggage encoding used by the
// OTEL_RESOURCE_ATTRIBUTES and OTEL_EXPORTER_OTLP_HEADERS spec. Entries with
// an empty key or value are dropped so callers don't accidentally emit blank
// resource attributes or auth headers.
const parseKeyValueList = (raw: string | undefined): Record<string, string> => {
  if (raw === undefined || raw.length === 0) return {}
  const out: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const key = safeDecode(pair.slice(0, eq).trim())
    const value = safeDecode(pair.slice(eq + 1).trim())
    if (key.length === 0 || value.length === 0) continue
    out[key] = value
  }
  return out
}

// Signal-specific headers fully replace the generic ones per the OTLP spec's
// "takes precedence" wording, matching how the Python/Java OTel SDKs interpret
// it. Merging would leak generic-only keys (e.g. a shared `Authorization`)
// into traces exports that intentionally set a different header set. An
// empty `OTEL_EXPORTER_OTLP_TRACES_HEADERS` still takes precedence and yields
// no headers rather than falling back to the generic value.
const resolveTracesHeaders = (env: OtelEnv): Record<string, string> => {
  if (env.OTEL_EXPORTER_OTLP_TRACES_HEADERS !== undefined) {
    return parseKeyValueList(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS)
  }
  return parseKeyValueList(env.OTEL_EXPORTER_OTLP_HEADERS)
}

const resolveServiceName = (
  env: OtelEnv,
  extraAttributes: Record<string, string>,
  defaultServiceName: string | undefined,
): string => {
  const explicit = env.OTEL_SERVICE_NAME?.trim() ?? ''
  if (explicit.length > 0) return explicit
  const fromAttrs = extraAttributes[ATTR_SERVICE_NAME] ?? ''
  if (fromAttrs.length > 0) return fromAttrs
  return defaultServiceName?.trim() ?? ''
}

const buildResource = (env: OtelEnv, serviceName: string): Resource => {
  const extra = parseKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES)
  return resourceFromAttributes({
    ...extra,
    [ATTR_SERVICE_NAME]: serviceName,
  })
}

const createOtlpTraceExporter = (env: OtelEnv): OTLPTraceExporter => {
  const url = resolveTracesEndpoint(env)
  const headers = resolveTracesHeaders(env)
  return new OTLPTraceExporter({
    ...(url.length > 0 ? { url } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  })
}

export const createNodeSdk = (options: OtelOptions): NodeSDK => {
  const {
    env,
    defaultServiceName,
    sampler,
    spanProcessors,
    propagator,
    contextManager,
  } = options
  const endpoint = resolveTracesEndpoint(env)
  if (endpoint.length === 0) {
    throw new Error(
      'OTEL_EXPORTER_OTLP_ENDPOINT (or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) is required to build the OpenTelemetry SDK. Provide a dummy endpoint in development if you do not have an OTLP collector configured.',
    )
  }
  const extraAttributes = parseKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES)
  const serviceName = resolveServiceName(
    env,
    extraAttributes,
    defaultServiceName,
  )
  if (serviceName.length === 0) {
    throw new Error(
      'OTEL_SERVICE_NAME (or `service.name` in OTEL_RESOURCE_ATTRIBUTES, or the `defaultServiceName` option) is required to build the OpenTelemetry SDK.',
    )
  }
  const traceExporter = createOtlpTraceExporter(env)
  const resource = buildResource(env, serviceName)
  const instrumentations = getNodeAutoInstrumentations()
  // NodeSDK's `spanProcessors` option replaces the default
  // BatchSpanProcessor(traceExporter) instead of appending to it, so prepend
  // it manually whenever the caller wires in extra processors.
  const hasExtraProcessors =
    spanProcessors !== undefined && spanProcessors.length > 0
  const mergedSpanProcessors = hasExtraProcessors
    ? [new BatchSpanProcessor(traceExporter), ...spanProcessors]
    : undefined
  return new NodeSDK({
    resource,
    traceExporter,
    instrumentations,
    ...(sampler ? { sampler } : {}),
    ...(mergedSpanProcessors ? { spanProcessors: mergedSpanProcessors } : {}),
    ...(propagator ? { textMapPropagator: propagator } : {}),
    ...(contextManager ? { contextManager } : {}),
  })
}
