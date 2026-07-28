import { afterEach, describe, expect, it, vi } from 'vitest'

import { createShutdownHandler, type ShutdownLogger } from '#shutdown/shutdown'

interface MockLogger {
  info: ReturnType<
    typeof vi.fn<(payload: Record<string, unknown>, msg: string) => void>
  >
  warn: ReturnType<
    typeof vi.fn<(payload: Record<string, unknown>, msg: string) => void>
  >
}

const makeLogger = (): MockLogger => ({
  info: vi.fn<(payload: Record<string, unknown>, msg: string) => void>(),
  warn: vi.fn<(payload: Record<string, unknown>, msg: string) => void>(),
})

afterEach(() => {
  process.removeAllListeners('SIGTERM')
  process.removeAllListeners('SIGINT')
})

describe('createShutdownHandler', () => {
  it('runs steps in order and reports a fully successful shutdown', async () => {
    const logger = makeLogger()
    const exit = vi.fn()
    const order: string[] = []
    const handle = createShutdownHandler(
      [
        { name: 'drain', run: () => void order.push('drain') },
        {
          name: 'close-server',
          run: () =>
            Promise.resolve().then(() => void order.push('close-server')),
        },
      ],
      { logger, exit },
    )

    await handle.shutdown('SIGTERM')

    expect({
      order,
      exitCalls: exit.mock.calls,
      infoCalls: logger.info.mock.calls,
      warnCalls: logger.warn.mock.calls,
    }).toEqual({
      order: ['drain', 'close-server'],
      exitCalls: [[0]],
      infoCalls: [
        [
          {
            event: 'shutdown_initiated',
            signal: 'SIGTERM',
            steps: ['drain', 'close-server'],
          },
          'shutdown signal received; running shutdown steps',
        ],
        [
          { event: 'shutdown_completed', signal: 'SIGTERM', hadError: false },
          'shutdown steps complete; exiting',
        ],
      ],
      warnCalls: [],
    })
  })

  it('continues past a failing step and reports a partially failed shutdown', async () => {
    const logger = makeLogger()
    const exit = vi.fn()
    const order: string[] = []
    const boom = new Error('drain failed')
    const handle = createShutdownHandler(
      [
        {
          name: 'drain',
          run: () => {
            throw boom
          },
        },
        { name: 'close-server', run: () => void order.push('close-server') },
      ],
      { logger, exit },
    )

    await handle.shutdown('SIGTERM')

    expect({
      order,
      exitCalls: exit.mock.calls,
      infoCalls: logger.info.mock.calls,
      warnCalls: logger.warn.mock.calls,
    }).toEqual({
      order: ['close-server'],
      exitCalls: [[1]],
      infoCalls: [
        [
          {
            event: 'shutdown_initiated',
            signal: 'SIGTERM',
            steps: ['drain', 'close-server'],
          },
          'shutdown signal received; running shutdown steps',
        ],
        [
          { event: 'shutdown_completed', signal: 'SIGTERM', hadError: true },
          'shutdown steps complete; exiting',
        ],
      ],
      warnCalls: [
        [
          {
            event: 'shutdown_step_failed',
            step: 'drain',
            error: 'drain failed',
          },
          'shutdown step failed',
        ],
      ],
    })
  })

  it('runs the underlying steps only once across repeated calls', async () => {
    const exit = vi.fn()
    const run = vi.fn()
    const handle = createShutdownHandler([{ name: 'step', run }], { exit })

    await Promise.all([handle.shutdown(), handle.shutdown()])
    await handle.shutdown()

    expect(run).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('detaches its signal listeners on shutdown so a second call re-registers fresh handlers', async () => {
    const before = process.listenerCount('SIGTERM')
    const first = createShutdownHandler([], { exit: vi.fn() })
    expect(process.listenerCount('SIGTERM')).toBe(before + 1)
    await first.shutdown()
    expect(process.listenerCount('SIGTERM')).toBe(before)

    const second = createShutdownHandler([], { exit: vi.fn() })
    expect(process.listenerCount('SIGTERM')).toBe(before + 1)
    await second.shutdown()
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })

  it.each([['SIGTERM'] as const, ['SIGINT'] as const])(
    'runs shutdown when %s is delivered to the process',
    async (signal) => {
      const logger = makeLogger()
      const exit = vi.fn()
      createShutdownHandler([], { logger, exit })

      process.emit(signal, signal)
      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledTimes(1)
      })

      expect({
        exitCalls: exit.mock.calls,
        infoCalls: logger.info.mock.calls,
      }).toEqual({
        exitCalls: [[0]],
        infoCalls: [
          [
            { event: 'shutdown_initiated', signal, steps: [] },
            'shutdown signal received; running shutdown steps',
          ],
          [
            { event: 'shutdown_completed', signal, hadError: false },
            'shutdown steps complete; exiting',
          ],
        ],
      })
    },
  )

  it('defaults the manual shutdown signal label to "manual"', async () => {
    const logger = makeLogger()
    const handle = createShutdownHandler([], { logger, exit: vi.fn() })

    await handle.shutdown()

    expect(logger.info.mock.calls).toEqual([
      [
        { event: 'shutdown_initiated', signal: 'manual', steps: [] },
        'shutdown signal received; running shutdown steps',
      ],
      [
        { event: 'shutdown_completed', signal: 'manual', hadError: false },
        'shutdown steps complete; exiting',
      ],
    ])
  })

  it('does not produce an unhandled rejection when a signal-triggered shutdown fails', async () => {
    const logger: ShutdownLogger = {
      info: () => {
        throw new Error('logger boom')
      },
      warn: () => {},
    }
    createShutdownHandler([], { logger, exit: vi.fn() })

    const unhandled = vi.fn()
    process.once('unhandledRejection', unhandled)
    process.emit('SIGTERM', 'SIGTERM')
    await new Promise((resolve) => setImmediate(resolve))
    process.off('unhandledRejection', unhandled)

    expect(unhandled).not.toHaveBeenCalled()
  })

  it('defaults to a no-op logger when none is provided', async () => {
    const noLogger: ShutdownLogger | undefined = undefined
    const handle = createShutdownHandler([{ name: 'step', run: () => {} }], {
      logger: noLogger,
      exit: vi.fn(),
    })

    await expect(handle.shutdown()).resolves.toBeUndefined()
  })
})
