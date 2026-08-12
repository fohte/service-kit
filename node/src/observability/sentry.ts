import type {
  ErrorEvent,
  NodeClient,
  NodeOptions,
  SeverityLevel,
} from '@sentry/node'
import * as Sentry from '@sentry/node'

import {
  DEFAULT_SECRET_KEY_PATTERNS,
  isRecord,
  redactContainer,
  type StringTruncator,
  type VisitedCaches,
} from '../redact'

export { DEFAULT_SECRET_KEY_PATTERNS, type StringTruncator } from '../redact'

export interface SentryEnv {
  readonly SENTRY_DSN?: string | undefined
  readonly SENTRY_ENVIRONMENT?: string | undefined
  readonly SENTRY_RELEASE?: string | undefined
}

export const NOISE_PATTERNS: ReadonlyArray<string | RegExp> = [
  'AbortError',
  /ECONNRESET/,
]

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
    // eslint-disable-next-line no-restricted-syntax -- initSentry's public contract is to throw synchronously when required config is missing
    throw new Error(
      'SENTRY_DSN is required to initialize Sentry. Provide a dummy value in development if you intentionally do not want to ship events.',
    )
  }
  const environment = env.SENTRY_ENVIRONMENT?.trim() ?? ''
  if (environment.length === 0) {
    // eslint-disable-next-line no-restricted-syntax -- initSentry's public contract is to throw synchronously when required config is missing
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
    // Sentry's default `httpIntegration`/`nativeNodeFetchIntegration` run
    // alongside OTel's own HTTP instrumentation even with
    // `skipOpenTelemetrySetup: true`, and only inject the W3C `traceparent`
    // header (in addition to `sentry-trace`) when this option is true.
    propagateTraceparent: true,
    beforeSend: (event: ErrorEvent) => redactEvent(event, redactOptions),
    ignoreErrors: [...NOISE_PATTERNS, ...(extraIgnoreErrors ?? [])],
    ...sentryOptions,
  })
  if (client === undefined) {
    // eslint-disable-next-line no-restricted-syntax -- initSentry's public contract is to throw synchronously when the underlying Sentry SDK fails to produce a client
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

export interface CaptureWithFingerprintContext {
  readonly level?: SeverityLevel | undefined
  readonly tags?:
    Readonly<Record<string, string | number | boolean>> | undefined
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
