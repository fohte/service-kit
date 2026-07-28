import { errAsync, okAsync, type Result } from 'neverthrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { retry, sleep } from '#retry/retry'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sleep', () => {
  it('resolves only after the given delay has elapsed', async () => {
    let resolved = false
    void sleep(1000).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(999)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(resolved).toBe(true)
  })
})

interface RetryCallRecord {
  readonly result: unknown
  readonly fnCalls: number
  readonly onRetryCalls: unknown[]
}

async function runRetry<T, E>(
  fn: () => ReturnType<typeof retry<T, E>>,
  fnMock: { mock: { calls: unknown[] } },
  onRetry: { mock: { calls: unknown[] } },
): Promise<RetryCallRecord> {
  const resultPromise = fn()
  await vi.runAllTimersAsync()
  const result: Result<T, E> = await resultPromise

  return {
    result: result.isOk() ? result.value : result.error,
    fnCalls: fnMock.mock.calls.length,
    onRetryCalls: onRetry.mock.calls,
  }
}

describe('retry', () => {
  it('returns the ok result without retrying when the first attempt succeeds', async () => {
    const fn = vi.fn(() => okAsync('done'))
    const onRetry = vi.fn()

    const record = await runRetry(() => retry(fn, { onRetry }), fn, onRetry)

    expect(record).toEqual({
      result: 'done',
      fnCalls: 1,
      onRetryCalls: [],
    })
  })

  it('retries with exponential backoff and succeeds once an attempt succeeds within maxRetries', async () => {
    let calls = 0
    const fn = vi.fn(() => {
      calls += 1
      return calls <= 2 ? errAsync(`fail-${String(calls)}`) : okAsync('done')
    })
    const onRetry = vi.fn()

    const record = await runRetry(
      () => retry(fn, { maxRetries: 3, initialDelayMs: 100, onRetry }),
      fn,
      onRetry,
    )

    expect(record).toEqual({
      result: 'done',
      fnCalls: 3,
      onRetryCalls: [
        [{ attempt: 1, delayMs: 100, error: 'fail-1' }],
        [{ attempt: 2, delayMs: 200, error: 'fail-2' }],
      ],
    })
  })

  it('stops retrying and returns the original error immediately when shouldRetry rejects it', async () => {
    const fn = vi.fn(() => errAsync('non-retryable'))
    const onRetry = vi.fn()

    const record = await runRetry(
      () => retry(fn, { shouldRetry: () => false, onRetry }),
      fn,
      onRetry,
    )

    expect(record).toEqual({
      result: 'non-retryable',
      fnCalls: 1,
      onRetryCalls: [],
    })
  })

  it('gives up and returns the original error after exhausting maxRetries', async () => {
    const fn = vi.fn(() => errAsync('always-fails'))
    const onRetry = vi.fn()

    const record = await runRetry(
      () => retry(fn, { maxRetries: 2, initialDelayMs: 10, onRetry }),
      fn,
      onRetry,
    )

    expect(record).toEqual({
      result: 'always-fails',
      fnCalls: 3,
      onRetryCalls: [
        [{ attempt: 1, delayMs: 10, error: 'always-fails' }],
        [{ attempt: 2, delayMs: 20, error: 'always-fails' }],
      ],
    })
  })

  it('uses the default maxRetries (3) and initialDelayMs (100ms) when options are omitted', async () => {
    const fn = vi.fn(() => errAsync('boom'))
    const onRetry = vi.fn()

    const record = await runRetry(() => retry(fn, { onRetry }), fn, onRetry)

    expect(record).toEqual({
      result: 'boom',
      fnCalls: 4,
      onRetryCalls: [
        [{ attempt: 1, delayMs: 100, error: 'boom' }],
        [{ attempt: 2, delayMs: 200, error: 'boom' }],
        [{ attempt: 3, delayMs: 400, error: 'boom' }],
      ],
    })
  })
})
