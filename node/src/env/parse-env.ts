import { err, ok, type Result } from 'neverthrow'

export class EnvValidationError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(
      `invalid environment:\n${issues.map((issue) => `- ${issue}`).join('\n')}`,
    )
    this.name = 'EnvValidationError'
  }
}

// Aggregates every field's issue instead of stopping at the first, so a
// misconfigured environment is reported in full on the first startup attempt
// rather than one variable at a time across repeated restarts.
export const parseEnv = <T extends Record<string, unknown>>(fields: {
  [K in keyof T]: Result<T[K], string>
}): Result<T, EnvValidationError> => {
  const issues: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- built up key-by-key below from `fields`, whose keys are exactly `keyof T`
  const parsed = {} as T
  for (const key of Object.keys(fields) as (keyof T)[]) {
    const result = fields[key]
    if (result.isErr()) {
      issues.push(result.error)
    } else {
      parsed[key] = result.value
    }
  }
  if (issues.length > 0) return err(new EnvValidationError(issues))
  return ok(parsed)
}
