import { errAsync, okAsync, type Result, type ResultAsync } from 'neverthrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { retry, type RetryOptions, sleep } from '#retry/retry'

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
  fn: ReturnType<typeof vi.fn<() => ResultAsync<T, E>>>,
  options: RetryOptions<E> & { onRetry: ReturnType<typeof vi.fn> },
): Promise<RetryCallRecord> {
  const resultPromise = retry(fn, options)
  await vi.runAllTimersAsync()
  const result: Result<T, E> = await resultPromise

  return {
    result: result.isOk() ? result.value : result.error,
    fnCalls: fn.mock.calls.length,
    onRetryCalls: options.onRetry.mock.calls,
  }
}

describe('retry', () => {
  it.each([
    {
      name: 'succeeds on the first attempt without retrying',
      failuresBeforeSuccess: 0,
      options: {},
      expected: { result: 'done', fnCalls: 1, onRetryCalls: [] },
    },
    {
      name: 'retries with exponential backoff then succeeds within maxRetries',
      failuresBeforeSuccess: 2,
      options: { maxRetries: 3, initialDelayMs: 100 },
      expected: {
        result: 'done',
        fnCalls: 3,
        onRetryCalls: [
          [{ attempt: 1, delayMs: 100, error: 'fail' }],
          [{ attempt: 2, delayMs: 200, error: 'fail' }],
        ],
      },
    },
    {
      name: 'stops retrying and returns the original error immediately when shouldRetry rejects it',
      failuresBeforeSuccess: Number.POSITIVE_INFINITY,
      options: { shouldRetry: () => false },
      expected: { result: 'fail', fnCalls: 1, onRetryCalls: [] },
    },
    {
      name: 'gives up and returns the original error after exhausting maxRetries',
      failuresBeforeSuccess: Number.POSITIVE_INFINITY,
      options: { maxRetries: 2, initialDelayMs: 10 },
      expected: {
        result: 'fail',
        fnCalls: 3,
        onRetryCalls: [
          [{ attempt: 1, delayMs: 10, error: 'fail' }],
          [{ attempt: 2, delayMs: 20, error: 'fail' }],
        ],
      },
    },
    {
      name: 'uses the default maxRetries (3) and initialDelayMs (100ms) when options are omitted',
      failuresBeforeSuccess: Number.POSITIVE_INFINITY,
      options: {},
      expected: {
        result: 'fail',
        fnCalls: 4,
        onRetryCalls: [
          [{ attempt: 1, delayMs: 100, error: 'fail' }],
          [{ attempt: 2, delayMs: 200, error: 'fail' }],
          [{ attempt: 3, delayMs: 400, error: 'fail' }],
        ],
      },
    },
  ])('$name', async ({ failuresBeforeSuccess, options, expected }) => {
    let calls = 0
    const fn = vi.fn(() => {
      calls += 1
      return calls <= failuresBeforeSuccess ? errAsync('fail') : okAsync('done')
    })
    const onRetry = vi.fn()

    const record = await runRetry(fn, { ...options, onRetry })

    expect(record).toEqual(expected)
  })

  it('does not require an onRetry callback', async () => {
    const fn = vi.fn(() => errAsync('fail'))

    const resultPromise = retry(fn, { maxRetries: 1, initialDelayMs: 5 })
    await vi.runAllTimersAsync()
    const result: Result<string, string> = await resultPromise

    expect({
      result: result.isOk() ? result.value : result.error,
      fnCalls: fn.mock.calls.length,
    }).toEqual({ result: 'fail', fnCalls: 2 })
  })
})
