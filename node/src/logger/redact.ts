import { DEFAULT_SECRET_KEY_PATTERNS } from '../observability/sentry'

const REDACTED = '[REDACTED]'

export interface RedactOptions {
  readonly extraSecretKeyPatterns?: ReadonlyArray<RegExp> | undefined
}

interface VisitedCaches {
  readonly records: WeakMap<Record<string, unknown>, Record<string, unknown>>
  readonly arrays: WeakMap<readonly unknown[], unknown[]>
}

// Only plain objects are traversed — class instances (Date / RegExp / Error)
// would lose their prototype if shallow-copied into `{}`.
const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const redactContainer = (
  container: Record<string, unknown>,
  secretPatterns: ReadonlyArray<RegExp>,
  visited: VisitedCaches,
): Record<string, unknown> => {
  const cached = visited.records.get(container)
  if (cached !== undefined) return cached

  const next: Record<string, unknown> = {}
  visited.records.set(container, next)

  for (const [key, value] of Object.entries(container)) {
    next[key] = redactValue(key, value, secretPatterns, visited)
  }
  return next
}

const redactArray = (
  array: readonly unknown[],
  secretPatterns: ReadonlyArray<RegExp>,
  visited: VisitedCaches,
): unknown[] => {
  const cached = visited.arrays.get(array)
  if (cached !== undefined) return cached

  const next: unknown[] = []
  visited.arrays.set(array, next)

  for (const entry of array) {
    next.push(redactContainedValue(entry, secretPatterns, visited))
  }
  return next
}

const redactContainedValue = (
  value: unknown,
  secretPatterns: ReadonlyArray<RegExp>,
  visited: VisitedCaches,
): unknown => {
  if (Array.isArray(value)) return redactArray(value, secretPatterns, visited)
  if (isRecord(value)) return redactContainer(value, secretPatterns, visited)
  return value
}

const redactValue = (
  key: string,
  value: unknown,
  secretPatterns: ReadonlyArray<RegExp>,
  visited: VisitedCaches,
): unknown => {
  if (secretPatterns.some((pattern) => pattern.test(key))) return REDACTED
  return redactContainedValue(value, secretPatterns, visited)
}

// Redacts every key in `fields` (at any depth) whose name matches a secret
// pattern. Unlike pino's built-in `redact` option — which only matches
// explicitly listed paths — this matches by key name anywhere in the tree,
// so it stays in sync with `DEFAULT_SECRET_KEY_PATTERNS` without having to
// enumerate every field a caller might log.
export const redactFields = <T extends Record<string, unknown>>(
  fields: T,
  options: RedactOptions = {},
): T => {
  const secretPatterns = [
    ...DEFAULT_SECRET_KEY_PATTERNS,
    ...(options.extraSecretKeyPatterns ?? []),
  ]
  const visited: VisitedCaches = {
    records: new WeakMap(),
    arrays: new WeakMap(),
  }
  // redactContainer preserves every key of `fields` (only some values are
  // replaced), so the result always has the shape of `T`.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- see comment above
  return redactContainer(fields, secretPatterns, visited) as T
}
