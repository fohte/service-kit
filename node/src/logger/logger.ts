import pino from 'pino'

import { redactFields, type RedactOptions } from './redact'

export type LogFields = Record<string, unknown>

export type LogLevel =
  'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent'

// Deliberately independent of `pino.Logger`: a small, stable surface that
// callers can implement with a fake in tests, and that this module could
// re-implement on a different logging backend later without a breaking
// change. Structurally compatible with `ObservabilityLogger` from
// `@fohte/service-kit/observability` (same `(payload, msg)` shape for
// `info`/`warn`), so a logger created here can be passed straight to
// `initObservability`'s `logger` option.
export interface Logger {
  trace(fields: LogFields, message: string): void
  debug(fields: LogFields, message: string): void
  info(fields: LogFields, message: string): void
  warn(fields: LogFields, message: string): void
  error(fields: LogFields, message: string): void
  fatal(fields: LogFields, message: string): void
  child(bindings: LogFields): Logger
}

export interface CreateLoggerOptions extends RedactOptions {
  readonly level?: LogLevel | undefined
  readonly base?: LogFields | undefined
  readonly pretty?: boolean | undefined
  readonly destination?: pino.DestinationStream | undefined
}

export const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
}

const wrap = (instance: pino.Logger, redactOptions: RedactOptions): Logger => ({
  trace: (fields, message) => {
    instance.trace(redactFields(fields, redactOptions), message)
  },
  debug: (fields, message) => {
    instance.debug(redactFields(fields, redactOptions), message)
  },
  info: (fields, message) => {
    instance.info(redactFields(fields, redactOptions), message)
  },
  warn: (fields, message) => {
    instance.warn(redactFields(fields, redactOptions), message)
  },
  error: (fields, message) => {
    instance.error(redactFields(fields, redactOptions), message)
  },
  fatal: (fields, message) => {
    instance.fatal(redactFields(fields, redactOptions), message)
  },
  child: (bindings) =>
    wrap(instance.child(redactFields(bindings, redactOptions)), redactOptions),
})

export const createLogger = (options: CreateLoggerOptions = {}): Logger => {
  const { level = 'info', base = null, pretty = false, destination } = options
  const redactOptions: RedactOptions = {
    extraSecretKeyPatterns: options.extraSecretKeyPatterns,
  }
  const pinoOptions: pino.LoggerOptions = {
    level,
    base,
    timestamp: pino.stdTimeFunctions.isoTime,
  }

  // pino's `transport` option cannot be combined with a caller-supplied
  // `destination` stream, so pretty-printing only engages when neither is
  // set — matching how tests inject a destination to capture NDJSON output.
  const instance =
    pretty && destination === undefined
      ? pino({ ...pinoOptions, transport: { target: 'pino-pretty' } })
      : pino(pinoOptions, destination)

  return wrap(instance, redactOptions)
}
