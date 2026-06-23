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
): NodeClient | undefined => {
  if (!isSentryConfigured(env)) return undefined
  const { extraIgnoreErrors, sentryOptions, ...redactOptions } = options
  return Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: env.SENTRY_RELEASE,
    skipOpenTelemetrySetup: true,
    beforeSend: (event: ErrorEvent) => redactEvent(event, redactOptions),
    ignoreErrors: [...NOISE_PATTERNS, ...(extraIgnoreErrors ?? [])],
    ...sentryOptions,
  })
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
  const visited = new WeakMap<object, Record<string, unknown>>()
  const cloned: T = Object.assign({}, event)

  const request: unknown = Reflect.get(cloned, 'request')
  if (isRecord(request)) {
    const headers: unknown = Reflect.get(request, 'headers')
    if (isRecord(headers)) {
      Reflect.set(cloned, 'request', {
        ...request,
        headers: redactContainer(headers, secretPatterns, truncators, visited),
      })
    }
  }
  for (const field of ['contexts', 'extra', 'tags', 'user'] as const) {
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

const redactContainer = (
  container: Record<string, unknown>,
  secretPatterns: ReadonlyArray<RegExp>,
  truncators: ReadonlyArray<StringTruncator>,
  visited: WeakMap<object, Record<string, unknown>>,
): Record<string, unknown> => {
  const cached = visited.get(container)
  if (cached) return cached

  const next: Record<string, unknown> = {}
  visited.set(container, next)

  for (const [key, value] of Object.entries(container)) {
    next[key] = redactValue(key, value, secretPatterns, truncators, visited)
  }
  return next
}

const redactValue = (
  key: string,
  value: unknown,
  secretPatterns: ReadonlyArray<RegExp>,
  truncators: ReadonlyArray<StringTruncator>,
  visited: WeakMap<object, Record<string, unknown>>,
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
    return value.map((entry) =>
      redactValue(key, entry, secretPatterns, truncators, visited),
    )
  }
  if (isRecord(value)) {
    return redactContainer(value, secretPatterns, truncators, visited)
  }
  return value
}
