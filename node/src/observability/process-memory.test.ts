import { metrics } from '@opentelemetry/api'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  readSmapsRssBreakdown,
  registerProcessMemoryMetrics,
} from '#observability/process-memory'

let meterProvider: MeterProvider | undefined

const smapsFixture = [
  '10000000-10001000 rw-p 00000000 00:00 0 [heap]',
  'Size:                  4 kB',
  'Rss:                   4 kB',
  '40000000-41000000 rw-p 00000000 00:00 0',
  'Size:              16384 kB',
  'Rss:                   2 kB',
  '41000000-44000000 ---p 00000000 00:00 0',
  'Size:              49152 kB',
  'Rss:                   0 kB',
  '80000000-80040000 rw-p 00000000 00:00 0',
  'Size:                 256 kB',
  'Rss:                  12 kB',
  '80040000-a0000000 ---p 00000000 00:00 0',
  'Size:             524032 kB',
  'Rss:                   0 kB',
  'b0000000-b0040000 rw-p 00000000 00:00 0',
  'Size:                 256 kB',
  'Rss:                 256 kB',
  'c0000000-c0001000 rw-p 00000000 00:00 0 /usr/lib/libexample.so',
  'Size:                   4 kB',
  'Rss:                   8 kB',
].join(String.fromCharCode(10))

afterEach(async () => {
  metrics.disable()
  await meterProvider?.shutdown()
  meterProvider = undefined
  vi.restoreAllMocks()
})

describe('readSmapsRssBreakdown', () => {
  it('groups the main heap and thread arena as glibc and separates V8 from other mappings', () => {
    expect(readSmapsRssBreakdown(smapsFixture)).toEqual({
      glibc: 6 * 1024,
      v8: 12 * 1024,
      other: 264 * 1024,
    })
  })
})

describe('registerProcessMemoryMetrics', () => {
  it.each([
    {
      name: 'procfs is unavailable',
      smaps: undefined,
      expectedSmaps: [],
    },
    {
      name: 'procfs is available',
      smaps: smapsFixture,
      expectedSmaps: [
        { attributes: { region: 'glibc' }, value: 6 * 1024 },
        { attributes: { region: 'v8' }, value: 12 * 1024 },
        { attributes: { region: 'other' }, value: 264 * 1024 },
      ],
    },
  ])(
    'exports memory gauges when $name',
    async ({ smaps: smapsText, expectedSmaps }) => {
      const exporter = new InMemoryMetricExporter(
        AggregationTemporality.CUMULATIVE,
      )
      meterProvider = new MeterProvider({
        readers: [new PeriodicExportingMetricReader({ exporter })],
      })
      metrics.setGlobalMeterProvider(meterProvider)
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        rss: 1024,
        external: 2048,
        arrayBuffers: 512,
        heapTotal: 4096,
        heapUsed: 3072,
      })

      registerProcessMemoryMetrics(() => smapsText)
      await meterProvider.forceFlush()

      const exported = exporter
        .getMetrics()
        .flatMap(({ scopeMetrics }) => scopeMetrics)
        .flatMap(({ metrics: scope }) => scope)
        .map(({ descriptor, dataPoints }) => ({
          name: descriptor.name,
          points: dataPoints.map(({ attributes, value }) => ({
            attributes,
            value,
          })),
        }))
        .sort((left, right) => left.name.localeCompare(right.name))

      const expected = [
        {
          name: 'nodejs.process.memory.array_buffers.bytes',
          points: [{ attributes: {}, value: 512 }],
        },
        {
          name: 'nodejs.process.memory.external.bytes',
          points: [{ attributes: {}, value: 2048 }],
        },
        {
          name: 'nodejs.process.memory.rss.bytes',
          points: [{ attributes: {}, value: 1024 }],
        },
        ...(smapsText === undefined
          ? []
          : [
              {
                name: 'nodejs.process.memory.smaps.rss.bytes',
                points: expectedSmaps,
              },
            ]),
      ].sort((left, right) => left.name.localeCompare(right.name))

      expect(exported).toEqual(expected)
    },
  )
})
