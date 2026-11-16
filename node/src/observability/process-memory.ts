import { readFileSync } from 'node:fs'

import { metrics } from '@opentelemetry/api'
import { Result } from 'neverthrow'

const KIB = 1024
const MIB = KIB * KIB
const THREAD_ARENA_SIZE = 64 * MIB
const V8_RESERVATION_SIZE = 512 * MIB
const V8_PAGE_SIZE = 256 * KIB

export type SmapsRegion = 'glibc' | 'v8' | 'other'

interface SmapsMapping {
  readonly start: number
  readonly end: number
  rss: number
  readonly name: string
}

const parseSmapsMappings = (smaps: string): SmapsMapping[] => {
  const mappings: SmapsMapping[] = []
  let current: SmapsMapping | undefined

  for (const line of smaps.split('\n')) {
    const header =
      /^([0-9a-f]+)-([0-9a-f]+)\s+\S+\s+\S+\s+\S+\s+\S+(?:\s+(.*))?$/i.exec(
        line,
      )
    if (header) {
      if (current) mappings.push(current)
      current = {
        start: Number.parseInt(header[1] ?? '0', 16),
        end: Number.parseInt(header[2] ?? '0', 16),
        rss: 0,
        name: header[3] ?? '',
      }
      continue
    }

    const rss = /^Rss:\s+(\d+)\s+kB$/i.exec(line)
    if (current && rss) current.rss = Number(rss[1]) * KIB
  }

  if (current) mappings.push(current)
  return mappings
}

const alignedRangeBases = (
  mapping: SmapsMapping,
  rangeSize: number,
): number[] => {
  const bases: number[] = []
  for (
    let base = Math.floor(mapping.start / rangeSize) * rangeSize;
    base < mapping.end;
    base += rangeSize
  ) {
    bases.push(base)
  }
  return bases
}

const mappedBytesInRange = (
  mappings: readonly SmapsMapping[],
  start: number,
  end: number,
): number =>
  mappings.reduce(
    (total, mapping) =>
      total +
      Math.max(0, Math.min(mapping.end, end) - Math.max(mapping.start, start)),
    0,
  )

const anonymousMappings = (mappings: readonly SmapsMapping[]) =>
  mappings.filter(
    (mapping) => mapping.name.length === 0 || /^\[anon:/i.test(mapping.name),
  )

const findAlignedRanges = (
  mappings: readonly SmapsMapping[],
  rangeSize: number,
): Set<number> => {
  const bases = new Set(
    mappings.flatMap((mapping) => alignedRangeBases(mapping, rangeSize)),
  )
  return new Set(
    [...bases].filter(
      (base) =>
        mappedBytesInRange(mappings, base, base + rangeSize) >= rangeSize,
    ),
  )
}

export const readSmapsRssBreakdown = (
  smaps: string,
): Record<SmapsRegion, number> => {
  const mappings = parseSmapsMappings(smaps)
  const anonymous = anonymousMappings(mappings)
  const v8Ranges = findAlignedRanges(anonymous, V8_RESERVATION_SIZE)
  const arenaRanges = findAlignedRanges(anonymous, THREAD_ARENA_SIZE)

  const totals: Record<SmapsRegion, number> = {
    glibc: 0,
    v8: 0,
    other: 0,
  }

  for (const mapping of mappings) {
    const isAnonymous =
      mapping.name.length === 0 || /^\[anon:/i.test(mapping.name)
    const isV8Range =
      isAnonymous &&
      alignedRangeBases(mapping, V8_RESERVATION_SIZE).some((base) =>
        v8Ranges.has(base),
      )
    const isArenaRange =
      isAnonymous &&
      alignedRangeBases(mapping, THREAD_ARENA_SIZE).some((base) =>
        arenaRanges.has(base),
      )
    const region: SmapsRegion =
      mapping.name === '[heap]'
        ? 'glibc'
        : isV8Range ||
            (isAnonymous && mapping.name.toLowerCase().includes('v8')) ||
            (isAnonymous && mapping.end - mapping.start === V8_PAGE_SIZE)
          ? 'v8'
          : isArenaRange
            ? 'glibc'
            : 'other'
    totals[region] += mapping.rss
  }

  return totals
}

const readLinuxSmaps = (): string | undefined =>
  Result.fromThrowable(
    () => readFileSync('/proc/self/smaps', 'utf8'),
    () => undefined,
  )().unwrapOr(undefined)

export const registerProcessMemoryMetrics = (
  getSmaps = readLinuxSmaps,
): void => {
  const meter = metrics.getMeter('@fohte/service-kit/observability')
  const rss = meter.createObservableGauge('nodejs.process.memory.rss.bytes')
  const external = meter.createObservableGauge(
    'nodejs.process.memory.external.bytes',
  )
  const arrayBuffers = meter.createObservableGauge(
    'nodejs.process.memory.array_buffers.bytes',
  )
  const smapsRss = meter.createObservableGauge(
    'nodejs.process.memory.smaps.rss.bytes',
  )

  rss.addCallback((result) => {
    result.observe(process.memoryUsage().rss)
  })
  external.addCallback((result) => {
    result.observe(process.memoryUsage().external)
  })
  arrayBuffers.addCallback((result) => {
    result.observe(process.memoryUsage().arrayBuffers)
  })
  smapsRss.addCallback((result) => {
    const smaps = getSmaps()
    if (smaps === undefined) return
    const breakdown = readSmapsRssBreakdown(smaps)
    for (const [region, value] of Object.entries(breakdown)) {
      result.observe(value, { region })
    }
  })
}
