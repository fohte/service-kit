import { err, ok } from 'neverthrow'
import { describe, expect, it } from 'vitest'

import { EnvValidationError, parseEnv } from '#env/parse-env'

describe('parseEnv', () => {
  it('returns Ok with all parsed values when every field succeeds', () => {
    expect(
      parseEnv({
        port: ok(8080),
        token: ok('secret'),
      }),
    ).toEqual(ok({ port: 8080, token: 'secret' }))
  })

  it('aggregates every field issue instead of stopping at the first', () => {
    const result = parseEnv({
      port: err('PORT must be a positive integer'),
      token: ok('secret'),
      logLevel: err('LOG_LEVEL must be one of debug, info'),
    })

    expect(result._unsafeUnwrapErr().issues).toEqual([
      'PORT must be a positive integer',
      'LOG_LEVEL must be one of debug, info',
    ])
  })
})

describe('EnvValidationError', () => {
  it('carries the issues and formats them into the message', () => {
    const error = new EnvValidationError(['A is missing', 'B is invalid'])

    expect(error.name).toBe('EnvValidationError')
    expect(error.message).toBe(
      'invalid environment:\n- A is missing\n- B is invalid',
    )
    expect(error.issues).toEqual(['A is missing', 'B is invalid'])
  })
})
