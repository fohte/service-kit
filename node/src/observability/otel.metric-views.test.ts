import { metrics } from '@opentelemetry/api'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { afterEach, describe, expect, it } from 'vitest'

import { createMetricViews } from '#observability/otel'

let meterProvider: MeterProvider | undefined

afterEach(async () => {
  metrics.disable()
  await meterProvider?.shutdown()
  meterProvider = undefined
})

describe('createMetricViews', () => {
  it('drops unused auto-instrumentation metrics and exports runtime and application metrics', async () => {
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    )
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
    })
    meterProvider = new MeterProvider({
      readers: [reader],
      views: createMetricViews(),
    })
    metrics.setGlobalMeterProvider(meterProvider)

    metrics
      .getMeter('@opentelemetry/instrumentation-http')
      .createHistogram('http.server.request.duration')
      .record(1)
    metrics
      .getMeter('@opentelemetry/instrumentation-undici')
      .createHistogram('http.client.request.duration')
      .record(1)

    const runtimeMeter = metrics.getMeter(
      '@opentelemetry/instrumentation-runtime-node',
    )
    runtimeMeter.createHistogram('v8js.gc.duration').record(1)
    const heapUsed = runtimeMeter.createObservableGauge('v8js.memory.heap.used')
    heapUsed.addCallback((result) => {
      result.observe(128)
    })
    const heapSpacePhysicalSize = runtimeMeter.createObservableGauge(
      'v8js.memory.heap.space.physical_size',
    )
    heapSpacePhysicalSize.addCallback((result) => {
      result.observe(256)
    })

    metrics.getMeter('application').createCounter('app.request.count').add(1)

    await meterProvider.forceFlush()

    const exportedMetricNames = exporter
      .getMetrics()
      .flatMap(({ scopeMetrics }) => scopeMetrics)
      .flatMap(({ metrics: scope }) => scope)
      .map(({ descriptor }) => descriptor.name)
      .sort()

    expect(exportedMetricNames).toEqual([
      'app.request.count',
      'v8js.memory.heap.space.physical_size',
      'v8js.memory.heap.used',
    ])
  })
})
