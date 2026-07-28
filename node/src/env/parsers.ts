import { err, ok, type Result } from 'neverthrow'

export type EnvSource = Readonly<Record<string, string | undefined>>

export interface IntConstraints {
  readonly min?: number
  readonly max?: number
}

const readRaw = (env: EnvSource, key: string): string | undefined => {
  const raw = env[key]
  return raw === undefined || raw === '' ? undefined : raw
}

const missing = (key: string): string =>
  `missing required environment variable: ${key}`

export const requireString = (
  env: EnvSource,
  key: string,
): Result<string, string> => {
  const raw = readRaw(env, key)
  if (raw === undefined) return err(missing(key))
  return ok(raw)
}

export function optionalString(
  env: EnvSource,
  key: string,
): Result<string | undefined, never>
export function optionalString(
  env: EnvSource,
  key: string,
  defaultValue: string,
): Result<string, never>
export function optionalString(
  env: EnvSource,
  key: string,
  defaultValue?: string,
): Result<string | undefined, never> {
  return ok(readRaw(env, key) ?? defaultValue)
}

const parseIntWithConstraints = (
  key: string,
  raw: string,
  { min, max }: IntConstraints,
): Result<number, string> => {
  const parsed = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(parsed)) {
    return err(`environment variable ${key} must be an integer (got: ${raw})`)
  }
  if (min !== undefined && parsed < min) {
    return err(
      `environment variable ${key} must be >= ${String(min)} (got: ${raw})`,
    )
  }
  if (max !== undefined && parsed > max) {
    return err(
      `environment variable ${key} must be <= ${String(max)} (got: ${raw})`,
    )
  }
  return ok(parsed)
}

export const requireInt = (
  env: EnvSource,
  key: string,
  constraints: IntConstraints = {},
): Result<number, string> => {
  const raw = readRaw(env, key)
  if (raw === undefined) return err(missing(key))
  return parseIntWithConstraints(key, raw, constraints)
}

export const optionalInt = (
  env: EnvSource,
  key: string,
  defaultValue: number,
  constraints: IntConstraints = {},
): Result<number, string> => {
  const raw = readRaw(env, key)
  if (raw === undefined) return ok(defaultValue)
  return parseIntWithConstraints(key, raw, constraints)
}

const enumMessage = (
  key: string,
  allowed: readonly string[],
  raw: string,
): string =>
  `environment variable ${key} must be one of ${allowed.join(', ')} (got: ${raw})`

export const requireEnum = <T extends string>(
  env: EnvSource,
  key: string,
  allowed: readonly T[],
): Result<T, string> => {
  const raw = readRaw(env, key)
  if (raw === undefined) return err(missing(key))
  if (!(allowed as readonly string[]).includes(raw)) {
    return err(enumMessage(key, allowed, raw))
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by the `includes` check above
  return ok(raw as T)
}

export const optionalEnum = <T extends string>(
  env: EnvSource,
  key: string,
  allowed: readonly T[],
  defaultValue: T,
): Result<T, string> => {
  const raw = readRaw(env, key)
  if (raw === undefined) return ok(defaultValue)
  if (!(allowed as readonly string[]).includes(raw)) {
    return err(enumMessage(key, allowed, raw))
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by the `includes` check above
  return ok(raw as T)
}
