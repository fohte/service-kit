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
  readonly OTEL_EXPORTER_OTLP_HEADERS?: string | undefined
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

const readEndpoint = (env: OtelEnv): string =>
  env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ?? ''

export const isOtelConfigured = (env: OtelEnv): boolean =>
  readEndpoint(env).length > 0

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

const buildResourceAttributes = (
  env: OtelEnv,
  defaultServiceName: string | undefined,
): Record<string, string> => {
  const extra = parseKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES)
  const explicit = env.OTEL_SERVICE_NAME?.trim() ?? ''
  const fromAttrs = extra[ATTR_SERVICE_NAME] ?? ''
  const fallback = defaultServiceName?.trim() ?? ''
  const serviceName =
    explicit.length > 0 ? explicit : fromAttrs.length > 0 ? fromAttrs : fallback
  return serviceName.length > 0
    ? { ...extra, [ATTR_SERVICE_NAME]: serviceName }
    : { ...extra }
}

const buildResource = (
  env: OtelEnv,
  defaultServiceName: string | undefined,
): Resource =>
  resourceFromAttributes(buildResourceAttributes(env, defaultServiceName))

const createOtlpTraceExporter = (env: OtelEnv): OTLPTraceExporter => {
  const endpoint = readEndpoint(env)
  const headers = parseKeyValueList(env.OTEL_EXPORTER_OTLP_HEADERS)
  return new OTLPTraceExporter({
    ...(endpoint.length > 0 ? { url: endpoint } : {}),
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
  const traceExporter = createOtlpTraceExporter(env)
  const resource = buildResource(env, defaultServiceName)
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
