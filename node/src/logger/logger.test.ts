import type pino from 'pino'
import { describe, expect, it } from 'vitest'

import { createLogger, noopLogger } from '#logger/logger'

class BufferStream implements pino.DestinationStream {
  private raw = ''

  write(chunk: string): void {
    this.raw += chunk
  }

  get lines(): ReadonlyArray<Record<string, unknown>> {
    return this.raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => parseLogLine(line))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseLogLine(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line)
  if (!isRecord(parsed)) {
    throw new Error(`expected a JSON object, got: ${line}`)
  }
  return parsed
}

function normalizeTime(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return { ...record, time: 'TIME' }
}

describe('createLogger', () => {
  it('emits one NDJSON line per call, with no pid/hostname by default', () => {
    const stream = new BufferStream()
    const logger = createLogger({ destination: stream })

    logger.info({ userId: 'U1' }, 'user action')

    expect(stream.lines.map(normalizeTime)).toEqual([
      { level: 30, time: 'TIME', userId: 'U1', msg: 'user action' },
    ])
  })

  it('filters out log lines below the configured level', () => {
    const stream = new BufferStream()
    const logger = createLogger({ level: 'warn', destination: stream })

    logger.info({}, 'suppressed')
    logger.warn({}, 'emitted')

    expect(stream.lines.map(normalizeTime)).toEqual([
      { level: 40, time: 'TIME', msg: 'emitted' },
    ])
  })

  it('merges the base option into every log line', () => {
    const stream = new BufferStream()
    const logger = createLogger({
      base: { service: 'my-service' },
      destination: stream,
    })

    logger.info({}, 'started')

    expect(stream.lines.map(normalizeTime)).toEqual([
      { level: 30, time: 'TIME', service: 'my-service', msg: 'started' },
    ])
  })

  it('redacts fields matching the default secret patterns', () => {
    const stream = new BufferStream()
    const logger = createLogger({ destination: stream })

    logger.info({ token: 'xoxb-1234', userId: 'U1' }, 'redacted')

    expect(stream.lines.map(normalizeTime)).toEqual([
      {
        level: 30,
        time: 'TIME',
        token: '[REDACTED]',
        userId: 'U1',
        msg: 'redacted',
      },
    ])
  })

  it('redacts extraSecretKeyPatterns fields in addition to the defaults', () => {
    const stream = new BufferStream()
    const logger = createLogger({
      destination: stream,
      extraSecretKeyPatterns: [/^signing_secret$/i],
    })

    logger.info({ signing_secret: 'sss' }, 'redacted')

    expect(stream.lines.map(normalizeTime)).toEqual([
      {
        level: 30,
        time: 'TIME',
        signing_secret: '[REDACTED]',
        msg: 'redacted',
      },
    ])
  })

  it('keeps an explicit destination even when pretty is requested, so tests stay on NDJSON', () => {
    const stream = new BufferStream()
    const logger = createLogger({ pretty: true, destination: stream })

    logger.info({}, 'hello')

    expect(stream.lines.map(normalizeTime)).toEqual([
      { level: 30, time: 'TIME', msg: 'hello' },
    ])
  })

  it('enables the pino-pretty transport when pretty is true and no destination is given', () => {
    expect(() => createLogger({ pretty: true })).not.toThrow()
  })

  describe('child', () => {
    it('includes redacted bindings on every log line from the child', () => {
      const stream = new BufferStream()
      const logger = createLogger({ destination: stream })
      const child = logger.child({ requestId: 'r1', token: 'secret' })

      child.info({}, 'started')
      child.warn({ extra: true }, 'finished')

      expect(stream.lines.map(normalizeTime)).toEqual([
        {
          level: 30,
          time: 'TIME',
          requestId: 'r1',
          token: '[REDACTED]',
          msg: 'started',
        },
        {
          level: 40,
          time: 'TIME',
          requestId: 'r1',
          token: '[REDACTED]',
          extra: true,
          msg: 'finished',
        },
      ])
    })
  })
})

describe('noopLogger', () => {
  it('does not throw at any level', () => {
    expect(() => {
      noopLogger.trace({}, 'a')
      noopLogger.debug({}, 'a')
      noopLogger.info({}, 'a')
      noopLogger.warn({}, 'a')
      noopLogger.error({}, 'a')
      noopLogger.fatal({}, 'a')
    }).not.toThrow()
  })

  it('child() returns itself', () => {
    expect(noopLogger.child({ foo: 'bar' })).toBe(noopLogger)
  })
})
