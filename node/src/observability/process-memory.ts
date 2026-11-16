import { readFileSync } from 'node:fs'

import { metrics } from '@opentelemetry/api'
import { Result } from 'neverthrow'

const KIB = 1024
const MIB = KIB * KIB
const THREAD_ARENA_SIZE = 64 * MIB
const V8_PAGE_SIZE = 256 * KIB
const V8_PAGE_CLUSTER_SIZE = 16 * MIB
// A single range of page-sized anonymous mappings may belong to another allocator.
const MIN_V8_PAGES_PER_CLUSTER = 8
const MIN_V8_PAGE_CLUSTERS = 2

export type SmapsRegion = 'glibc' | 'v8' | 'other'

interface SmapsMapping {
  readonly start: number
  readonly end: number
  readonly permissions: string
  rss: number
  readonly name: string
}

interface ProcessMemoryLogger {
  warn(payload: Record<string, unknown>, msg: string): void
}

type SmapsReadResult = Result<string, unknown> | undefined

const parseSmapsMappings = (smaps: string): SmapsMapping[] => {
  const mappings: SmapsMapping[] = []
  let current: SmapsMapping | undefined

  for (const line of smaps.split('\n')) {
    const header =
      /^([0-9a-f]+)-([0-9a-f]+)\s+(\S+)\s+\S+\s+\S+\s+\S+(?:\s+(.*))?$/i.exec(
        line,
      )
    if (header) {
      if (current) mappings.push(current)
      current = {
        start: Number.parseInt(header[1] ?? '0', 16),
        end: Number.parseInt(header[2] ?? '0', 16),
        permissions: header[3] ?? '',
        rss: 0,
        name: header[4] ?? '',
      }
      continue
    }

    const rss = /^Rss:\s+(\d+)\s+kB$/i.exec(line)
    if (current && rss) current.rss = Number(rss[1]) * KIB
  }

  if (current) mappings.push(current)
  return mappings
}

const isAnonymousMapping = (mapping: SmapsMapping): boolean =>
  mapping.name.length === 0 || /^\[anon:/i.test(mapping.name)

const v8PageClusterCounts = (
  mappings: readonly SmapsMapping[],
): Map<number, number> => {
  const counts = new Map<number, number>()
  for (const mapping of mappings) {
    if (
      !isAnonymousMapping(mapping) ||
      mapping.end - mapping.start !== V8_PAGE_SIZE ||
      mapping.start % V8_PAGE_SIZE !== 0
    ) {
      continue
    }

    const cluster = Math.floor(mapping.start / V8_PAGE_CLUSTER_SIZE)
    counts.set(cluster, (counts.get(cluster) ?? 0) + 1)
  }
  return counts
}

const isThreadArenaMapping = (
  mappings: readonly SmapsMapping[],
  index: number,
): boolean => {
  const mapping = mappings[index]
  if (!mapping) return false

  const size = mapping.end - mapping.start
  const hasArenaShape =
    isAnonymousMapping(mapping) &&
    mapping.permissions.includes('w') &&
    mapping.start % THREAD_ARENA_SIZE === 0 &&
    size > MIB &&
    size <= THREAD_ARENA_SIZE
  if (!hasArenaShape) return false
  if (size === THREAD_ARENA_SIZE) return true

  const guardMapping = mappings[index + 1]
  return (
    guardMapping !== undefined &&
    guardMapping.start === mapping.end &&
    guardMapping.end === mapping.start + THREAD_ARENA_SIZE &&
    guardMapping.permissions.startsWith('---') &&
    isAnonymousMapping(guardMapping)
  )
}

export const readSmapsRssBreakdown = (
  smaps: string,
): Record<SmapsRegion, number> => {
  const mappings = parseSmapsMappings(smaps)
  const pageClusters = v8PageClusterCounts(mappings)
  const populatedV8ClusterCount = [...pageClusters.values()].filter(
    (count) => count >= MIN_V8_PAGES_PER_CLUSTER,
  ).length
  const totals: Record<SmapsRegion, number> = {
    glibc: 0,
    v8: 0,
    other: 0,
  }

  for (const [index, mapping] of mappings.entries()) {
    const isAnonymous = isAnonymousMapping(mapping)
    const isV8PageCluster =
      isAnonymous &&
      mapping.end - mapping.start === V8_PAGE_SIZE &&
      mapping.start % V8_PAGE_SIZE === 0 &&
      populatedV8ClusterCount >= MIN_V8_PAGE_CLUSTERS &&
      (pageClusters.get(Math.floor(mapping.start / V8_PAGE_CLUSTER_SIZE)) ??
        0) >= MIN_V8_PAGES_PER_CLUSTER
    const region: SmapsRegion =
      mapping.name === '[heap]' || isThreadArenaMapping(mappings, index)
        ? 'glibc'
        : isAnonymous &&
            (mapping.name.toLowerCase().includes('v8') || isV8PageCluster)
          ? 'v8'
          : 'other'
    totals[region] += mapping.rss
  }

  return totals
}

export const readLinuxSmaps = (
  platform: NodeJS.Platform = process.platform,
  readSmaps = (): string => readFileSync('/proc/self/smaps', 'utf8'),
): SmapsReadResult => {
  if (platform !== 'linux') return undefined
  return Result.fromThrowable(readSmaps, (error: unknown) => error)()
}

export const registerProcessMemoryMetrics = (
  logger: ProcessMemoryLogger,
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
  let hasWarnedAboutSmapsRead = false

  meter.addBatchObservableCallback(
    (result) => {
      const memoryUsage = process.memoryUsage()
      result.observe(rss, memoryUsage.rss)
      result.observe(external, memoryUsage.external)
      result.observe(arrayBuffers, memoryUsage.arrayBuffers)

      const smaps = getSmaps()
      if (smaps === undefined) return
      if (!smaps.isOk()) {
        if (!hasWarnedAboutSmapsRead) {
          hasWarnedAboutSmapsRead = true
          const error = smaps.error
          // A logger failure must not discard observations buffered for this batch.
          Result.fromThrowable(
            () => {
              logger.warn(
                {
                  event: 'process_memory_smaps_read_failed',
                  error: error instanceof Error ? error.message : String(error),
                },
                'failed to read process smaps',
              )
            },
            (warningError: unknown) => warningError,
          )().match(
            () => undefined,
            () => undefined,
          )
        }
        return
      }

      const breakdown = readSmapsRssBreakdown(smaps.value)
      for (const [region, value] of Object.entries(breakdown)) {
        result.observe(smapsRss, value, { region })
      }
    },
    [rss, external, arrayBuffers, smapsRss],
  )
}
