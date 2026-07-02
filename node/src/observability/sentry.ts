import type {
  ErrorEvent,
  NodeClient,
  NodeOptions,
  SeverityLevel,
} from '@sentry/node'
import * as Sentry from '@sentry/node'

export interface SentryEnv {
  readonly SENTRY_DSN?: string | undefined
  readonly SENTRY_ENVIRONMENT?: string | undefined
  readonly SENTRY_RELEASE?: string | undefined
}

export const NOISE_PATTERNS: ReadonlyArray<string | RegExp> = [
  'AbortError',
  /ECONNRESET/,
]

const REDACTED = '[REDACTED]'

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

export interface RedactOptions {
  readonly extraSecretKeyPatterns?: ReadonlyArray<RegExp>
  readonly extraStringTruncators?: ReadonlyArray<StringTruncator>
}

export interface InitSentryOptions extends RedactOptions {
  readonly extraIgnoreErrors?: ReadonlyArray<string | RegExp>
  readonly sentryOptions?: Partial<NodeOptions>
}

export const isSentryConfigured = (env: SentryEnv): boolean => {
  const dsn = env.SENTRY_DSN?.trim() ?? ''
  return dsn.length > 0
}

export const initSentry = (
  env: SentryEnv,
  options: InitSentryOptions = {},
): NodeClient => {
  const dsn = env.SENTRY_DSN?.trim() ?? ''
  if (dsn.length === 0) {
    throw new Error(
      'SENTRY_DSN is required to initialize Sentry. Provide a dummy value in development if you intentionally do not want to ship events.',
    )
  }
  const environment = env.SENTRY_ENVIRONMENT?.trim() ?? ''
  if (environment.length === 0) {
    throw new Error(
      'SENTRY_ENVIRONMENT is required to initialize Sentry. Provide a dummy value in development if you intentionally do not want to ship events.',
    )
  }
  const { extraIgnoreErrors, sentryOptions, ...redactOptions } = options
  const client = Sentry.init({
    dsn,
    environment,
    release: env.SENTRY_RELEASE,
    skipOpenTelemetrySetup: true,
    // SentryPropagator (installed by init.ts when Sentry is started) only
    // injects the W3C `traceparent` header when this option is true. Without
    // it, downstream services silently lose cross-service trace linking even
    // when the caller is not shipping spans to Sentry.
    propagateTraceparent: true,
    beforeSend: (event: ErrorEvent) => redactEvent(event, redactOptions),
    ignoreErrors: [...NOISE_PATTERNS, ...(extraIgnoreErrors ?? [])],
    ...sentryOptions,
  })
  if (client === undefined) {
    throw new Error(
      'Sentry.init returned no client; check the SDK options for invalid values.',
    )
  }
  return client
}

export const redactEvent = <T extends object>(
  event: T,
  options: RedactOptions = {},
): T => {
  if (!isRecord(event)) return event
  const secretPatterns = [
    ...DEFAULT_SECRET_KEY_PATTERNS,
    ...(options.extraSecretKeyPatterns ?? []),
  ]
  const truncators = options.extraStringTruncators ?? []
  const visited: VisitedCaches = {
    records: new WeakMap<Record<string, unknown>, Record<string, unknown>>(),
    arrays: new WeakMap<readonly unknown[], unknown[]>(),
  }
  const cloned: T = Object.assign({}, event)

  for (const field of [
    'request',
    'contexts',
    'extra',
    'tags',
    'user',
  ] as const) {
    const value: unknown = Reflect.get(cloned, field)
    if (isRecord(value)) {
      Reflect.set(
        cloned,
        field,
        redactContainer(value, secretPatterns, truncators, visited),
      )
    }
  }
  const breadcrumbs: unknown = Reflect.get(cloned, 'breadcrumbs')
  if (Array.isArray(breadcrumbs)) {
    Reflect.set(
      cloned,
      'breadcrumbs',
      (breadcrumbs as unknown[]).map((entry): unknown =>
        isRecord(entry)
          ? redactContainer(entry, secretPatterns, truncators, visited)
          : entry,
      ),
    )
  }
  return cloned
}

// Only plain objects are traversed — class instances (Date / RegExp / Error /
// logger handles) would lose their prototype if shallow-copied into `{}`.
const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export interface CaptureWithFingerprintContext {
  readonly level?: SeverityLevel | undefined
  readonly tags?:
    | Readonly<Record<string, string | number | boolean>>
    | undefined
  readonly extras?: Readonly<Record<string, unknown>> | undefined
}

export const captureWithFingerprint = (
  err: unknown,
  fingerprintKey: string | readonly string[],
  context: CaptureWithFingerprintContext = {},
): void => {
  Sentry.withScope((scope) => {
    const fingerprint =
      typeof fingerprintKey === 'string'
        ? [fingerprintKey]
        : [...fingerprintKey]
    scope.setFingerprint(fingerprint)
    if (context.level !== undefined) scope.setLevel(context.level)
    if (context.tags !== undefined) {
      for (const [key, value] of Object.entries(context.tags)) {
        scope.setTag(key, value)
      }
    }
    if (context.extras !== undefined) {
      for (const [key, value] of Object.entries(context.extras)) {
        scope.setExtra(key, value)
      }
    }
    Sentry.captureException(err)
  })
}

interface VisitedCaches {
  readonly records: WeakMap<Record<string, unknown>, Record<string, unknown>>
  readonly arrays: WeakMap<readonly unknown[], unknown[]>
}

const redactContainer = (
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

const redactArray = (
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

const redactValue = (
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
