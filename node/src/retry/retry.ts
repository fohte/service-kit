import { errAsync, Result, ResultAsync } from 'neverthrow'

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export interface RetryAttemptInfo<E> {
  readonly attempt: number
  readonly delayMs: number
  readonly error: E
}

export interface RetryOptions<E> {
  readonly maxRetries?: number | undefined
  readonly initialDelayMs?: number | undefined
  readonly shouldRetry?: ((error: E) => boolean) | undefined
  readonly onRetry?: ((info: RetryAttemptInfo<E>) => void) | undefined
}

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_INITIAL_DELAY_MS = 100

export function retry<T, E>(
  fn: () => ResultAsync<T, E>,
  options: RetryOptions<E> = {},
): ResultAsync<T, E> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const shouldRetry = options.shouldRetry ?? (() => true)
  // `shouldRetry`/`onRetry` are caller-supplied and may assume an error shape
  // that doesn't hold for every error this loop sees. A throw from either
  // would otherwise reject the returned ResultAsync, breaking this module's
  // no-throw contract for callers who never wrote a try/catch around it.
  const safeShouldRetry = Result.fromThrowable(shouldRetry, () => false)
  const safeOnRetry = Result.fromThrowable(
    (info: RetryAttemptInfo<E>) => options.onRetry?.(info),
    () => undefined,
  )

  const attemptFrom = (failureCount: number): ResultAsync<T, E> =>
    fn().orElse((error) => {
      const isRetryable = safeShouldRetry(error).unwrapOr(false)
      if (!isRetryable || failureCount >= maxRetries) {
        return errAsync(error)
      }

      const delayMs = initialDelayMs * 2 ** failureCount
      safeOnRetry({ attempt: failureCount + 1, delayMs, error }).unwrapOr(
        undefined,
      )

      return ResultAsync.fromSafePromise(sleep(delayMs)).andThen(() =>
        attemptFrom(failureCount + 1),
      )
    })

  return attemptFrom(0)
}
