import { metrics } from '@opentelemetry/api'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { err, ok } from 'neverthrow'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  readLinuxSmaps,
  readSmapsRssBreakdown,
  registerProcessMemoryMetrics,
} from '#observability/process-memory'

let meterProvider: MeterProvider | undefined

const smapsMapping = (
  range: string,
  permissions: string,
  rssKb: number,
  name = '',
): string =>
  [
    `${range} ${permissions} 00000000 00:00 0${name ? ` ${name}` : ''}`,
    `Rss: ${rssKb.toString()} kB`,
  ].join('\n')

const smapsFixture = [
  smapsMapping('10000000-10001000', 'rw-p', 4, '[heap]'),
  smapsMapping('20000000-21000000', 'rw-p', 16384),
  smapsMapping('40000000-40aaa000', 'rw-p', 2),
  smapsMapping('40aaa000-44000000', '---p', 0),
  smapsMapping('50000000-54000000', 'rw-p', 3),
  smapsMapping('c0000000-c0001000', 'rw-p', 8, '/usr/lib/libexample.so'),
  smapsMapping('100000000-100040000', 'rw-p', 256),
  smapsMapping('100080000-1000c0000', 'rw-p', 256),
  smapsMapping('100100000-100140000', 'rw-p', 256),
  smapsMapping('100180000-1001c0000', 'rw-p', 256),
  smapsMapping('100200000-100240000', 'rw-p', 256),
  smapsMapping('100280000-1002c0000', 'rw-p', 256),
  smapsMapping('100300000-100340000', 'rw-p', 256),
  smapsMapping('100380000-1003c0000', 'rw-p', 256),
  smapsMapping('101000000-101040000', 'rw-p', 256),
  smapsMapping('101080000-1010c0000', 'rw-p', 256),
  smapsMapping('101100000-101140000', 'rw-p', 256),
  smapsMapping('101180000-1011c0000', 'rw-p', 256),
  smapsMapping('101200000-101240000', 'rw-p', 256),
  smapsMapping('101280000-1012c0000', 'rw-p', 256),
  smapsMapping('101300000-101340000', 'rw-p', 256),
  smapsMapping('101380000-1013c0000', 'rw-p', 256),
  smapsMapping('200000000-200040000', 'rw-p', 256),
  smapsMapping('8101200000-8121200000', 'rw-p', 12288),
].join('\n')

const singleV8PageClusterFixture = [
  smapsMapping('100000000-100040000', 'rw-p', 256),
  smapsMapping('100080000-1000c0000', 'rw-p', 256),
  smapsMapping('100100000-100140000', 'rw-p', 256),
  smapsMapping('100180000-1001c0000', 'rw-p', 256),
  smapsMapping('100200000-100240000', 'rw-p', 256),
  smapsMapping('100280000-1002c0000', 'rw-p', 256),
  smapsMapping('100300000-100340000', 'rw-p', 256),
  smapsMapping('100380000-1003c0000', 'rw-p', 256),
].join('\n')

const unalignedV8PageClusterFixture = [
  smapsMapping('100001000-100041000', 'rw-p', 256),
  smapsMapping('100081000-1000c1000', 'rw-p', 256),
  smapsMapping('100101000-100141000', 'rw-p', 256),
  smapsMapping('100181000-1001c1000', 'rw-p', 256),
  smapsMapping('100201000-100241000', 'rw-p', 256),
  smapsMapping('100281000-1002c1000', 'rw-p', 256),
  smapsMapping('100301000-100341000', 'rw-p', 256),
  smapsMapping('100381000-1003c1000', 'rw-p', 256),
].join('\n')

const metricSnapshot = (
  exported: unknown,
  memoryUsageCalls: unknown,
  warnings: unknown,
) => ({
  exported,
  memoryUsageCalls,
  warnings,
})

const smapsReadSnapshot = (result: unknown, readCalls: unknown) => ({
  result,
  readCalls,
})

afterEach(async () => {
  metrics.disable()
  await meterProvider?.shutdown()
  meterProvider = undefined
  vi.restoreAllMocks()
})

describe('readSmapsRssBreakdown', () => {
  it('classifies arena-shaped mappings and clustered V8 pages while leaving ambiguous mappings in other', () => {
    expect(readSmapsRssBreakdown(smapsFixture)).toEqual({
      glibc: 9 * 1024,
      v8: 4 * 1024 * 1024,
      other: 28 * 1024 * 1024 + 264 * 1024,
    })
  })

  it.each([
    {
      name: 'eight aligned pages in one range without a second V8 cluster',
      smaps: singleV8PageClusterFixture,
      expected: { glibc: 0, v8: 0, other: 2 * 1024 * 1024 },
    },
    {
      name: 'unaligned anonymous mappings with the V8 page size',
      smaps: unalignedV8PageClusterFixture,
      expected: { glibc: 0, v8: 0, other: 2 * 1024 * 1024 },
    },
    {
      name: 'a fully used arena without a guard mapping',
      smaps: smapsMapping('50000000-54000000', 'rw-p', 3),
      expected: { glibc: 3 * 1024, v8: 0, other: 0 },
    },
    {
      name: 'a large aligned anonymous mapping without arena shape',
      smaps: smapsMapping('20000000-21000000', 'rw-p', 16384),
      expected: { glibc: 0, v8: 0, other: 16 * 1024 * 1024 },
    },
    {
      name: 'a large non-aligned anonymous reservation',
      smaps: smapsMapping('8101200000-8121200000', 'rw-p', 12288),
      expected: { glibc: 0, v8: 0, other: 12 * 1024 * 1024 },
    },
  ])('classifies $name', ({ smaps, expected }) => {
    expect(readSmapsRssBreakdown(smaps)).toEqual(expected)
  })
})

describe('readLinuxSmaps', () => {
  it('does not read procfs on non-Linux platforms', () => {
    const readSmaps = vi.fn(() => smapsFixture)

    expect(
      smapsReadSnapshot(
        readLinuxSmaps('darwin', readSmaps),
        readSmaps.mock.calls,
      ),
    ).toEqual(smapsReadSnapshot(undefined, []))
  })

  it('returns Linux procfs read errors as a Result', () => {
    const readSmaps = vi.fn(() => {
      throw new Error('EACCES')
    })
    const result = readLinuxSmaps('linux', readSmaps)?.mapErr((error) =>
      error instanceof Error ? error.message : String(error),
    )
    expect(smapsReadSnapshot(result, readSmaps.mock.calls)).toEqual(
      smapsReadSnapshot(err('EACCES'), [[]]),
    )
  })
})

describe('registerProcessMemoryMetrics', () => {
  it.each([
    {
      name: 'procfs is unavailable',
      smaps: undefined,
      expectedSmaps: [],
      expectedWarnings: [],
      throwOnWarning: false,
    },
    {
      name: 'procfs is available',
      smaps: ok(smapsFixture),
      expectedSmaps: [
        { attributes: { region: 'glibc' }, value: 9 * 1024 },
        { attributes: { region: 'v8' }, value: 4 * 1024 * 1024 },
        {
          attributes: { region: 'other' },
          value: 28 * 1024 * 1024 + 264 * 1024,
        },
      ],
      expectedWarnings: [],
      throwOnWarning: false,
    },
    {
      name: 'procfs read fails',
      smaps: err(new Error('EACCES')),
      expectedSmaps: [],
      expectedWarnings: [
        {
          payload: {
            event: 'process_memory_smaps_read_failed',
            error: 'EACCES',
          },
          message: 'failed to read process smaps',
        },
      ],
      throwOnWarning: false,
    },
    {
      name: 'procfs read fails and logger throws',
      smaps: err(new Error('EACCES')),
      expectedSmaps: [],
      expectedWarnings: [
        {
          payload: {
            event: 'process_memory_smaps_read_failed',
            error: 'EACCES',
          },
          message: 'failed to read process smaps',
        },
      ],
      throwOnWarning: true,
    },
  ])(
    'exports memory gauges when $name',
    async ({
      smaps: smapsResult,
      expectedSmaps,
      expectedWarnings,
      throwOnWarning,
    }) => {
      const exporter = new InMemoryMetricExporter(
        AggregationTemporality.CUMULATIVE,
      )
      meterProvider = new MeterProvider({
        readers: [new PeriodicExportingMetricReader({ exporter })],
      })
      metrics.setGlobalMeterProvider(meterProvider)
      const memoryUsage = vi.spyOn(process, 'memoryUsage').mockReturnValue({
        rss: 1024,
        external: 2048,
        arrayBuffers: 512,
        heapTotal: 4096,
        heapUsed: 3072,
      })
      const warnings: Array<{
        readonly payload: Record<string, unknown>
        readonly message: string
      }> = []

      registerProcessMemoryMetrics(
        {
          warn: (payload, message) => {
            warnings.push({ payload, message })
            if (throwOnWarning) throw new Error('logger failure')
          },
        },
        () => smapsResult,
      )
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
        ...(smapsResult === undefined || smapsResult.isErr()
          ? []
          : [
              {
                name: 'nodejs.process.memory.smaps.rss.bytes',
                points: expectedSmaps,
              },
            ]),
      ].sort((left, right) => left.name.localeCompare(right.name))

      expect(
        metricSnapshot(exported, memoryUsage.mock.calls, warnings),
      ).toEqual(metricSnapshot(expected, [[]], expectedWarnings))
    },
  )

  it('logs only once when Linux smaps reads repeatedly fail', async () => {
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    )
    meterProvider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter })],
    })
    metrics.setGlobalMeterProvider(meterProvider)
    const warnings: Array<{
      readonly payload: Record<string, unknown>
      readonly message: string
    }> = []

    registerProcessMemoryMetrics(
      {
        warn: (payload, message) => warnings.push({ payload, message }),
      },
      () => err(new Error('EACCES')),
    )
    await meterProvider.forceFlush()
    await meterProvider.forceFlush()

    expect(warnings).toEqual([
      {
        payload: {
          event: 'process_memory_smaps_read_failed',
          error: 'EACCES',
        },
        message: 'failed to read process smaps',
      },
    ])
  })
})
