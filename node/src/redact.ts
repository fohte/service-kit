export const REDACTED = '[REDACTED]'

// Each pattern anchors on `(?:^|_)` so a bare key (`token`, `dsn`, `api_key`)
// matches as well as suffixed keys (`SLACK_BOT_TOKEN`, `database_dsn`).
// camelCase keys (`accessToken`) do not match — pass them via
// `extraSecretKeyPatterns`.
export const DEFAULT_SECRET_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|_)token$/i,
  /(?:^|_)dsn$/i,
  /(?:^|_)api[_-]?key$/i,
  /^authorization$/i,
]

export interface StringTruncator {
  readonly pattern: RegExp
  readonly maxLength: number
}

export interface VisitedCaches {
  readonly records: WeakMap<Record<string, unknown>, Record<string, unknown>>
  readonly arrays: WeakMap<readonly unknown[], unknown[]>
}

// Only plain objects are traversed — class instances (Date / RegExp / Error /
// logger handles) would lose their prototype if shallow-copied into `{}`.
export const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export const redactContainer = (
  container: Record<string, unknown>,
  secretPatterns: ReadonlyArray<RegExp>,
  truncators: ReadonlyArray<StringTruncator>,
  visited: VisitedCaches,
): Record<string, unknown> => {
  const cached = visited.records.get(container)
  if (cached !== undefined) return cached

  const next: Record<string, unknown> = {}
  visited.records.set(container, next)

  for (const [key, value] of Object.entries(container)) {
    next[key] = redactValue(key, value, secretPatterns, truncators, visited)
  }
  return next
}

export const redactArray = (
  key: string,
  array: readonly unknown[],
  secretPatterns: ReadonlyArray<RegExp>,
  truncators: ReadonlyArray<StringTruncator>,
  visited: VisitedCaches,
): unknown[] => {
  const cached = visited.arrays.get(array)
  if (cached !== undefined) return cached

  const next: unknown[] = []
  visited.arrays.set(array, next)

  for (const entry of array) {
    next.push(redactValue(key, entry, secretPatterns, truncators, visited))
  }
  return next
}

export const redactValue = (
  key: string,
  value: unknown,
  secretPatterns: ReadonlyArray<RegExp>,
  truncators: ReadonlyArray<StringTruncator>,
  visited: VisitedCaches,
): unknown => {
  if (secretPatterns.some((pattern) => pattern.test(key))) return REDACTED
  if (typeof value === 'string') {
    const truncator = truncators.find(({ pattern }) => pattern.test(key))
    if (truncator !== undefined) {
      return value.length <= truncator.maxLength
        ? value
        : value.slice(0, truncator.maxLength)
    }
  }
  if (Array.isArray(value)) {
    return redactArray(key, value, secretPatterns, truncators, visited)
  }
  if (isRecord(value)) {
    return redactContainer(value, secretPatterns, truncators, visited)
  }
  return value
}
