import {
  DEFAULT_SECRET_KEY_PATTERNS,
  redactContainer,
  type VisitedCaches,
} from '../redact'

export interface RedactOptions {
  readonly extraSecretKeyPatterns?: ReadonlyArray<RegExp> | undefined
}

// Redacts every key in `fields` (at any depth) whose name matches a secret
// pattern.
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
  return redactContainer(fields, secretPatterns, [], visited) as T
}
