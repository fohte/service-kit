import { err, ok } from 'neverthrow'
import { describe, expect, it } from 'vitest'

import {
  optionalEnum,
  optionalInt,
  optionalString,
  requireEnum,
  requireInt,
  requireString,
} from '#env/parsers'

describe('requireString', () => {
  it('returns the value when present', () => {
    expect(requireString({ FOO: 'bar' }, 'FOO')).toEqual(ok('bar'))
  })

  it.each([
    { name: 'missing', env: {} },
    { name: 'empty', env: { FOO: '' } },
  ])('errs when the value is $name', ({ env }) => {
    expect(requireString(env, 'FOO')).toEqual(
      err('missing required environment variable: FOO'),
    )
  })
})

describe('optionalString', () => {
  it('returns the value when present', () => {
    expect(optionalString({ FOO: 'bar' }, 'FOO')).toEqual(ok('bar'))
  })

  it('returns undefined when missing and no default is given', () => {
    expect(optionalString({}, 'FOO')).toEqual(ok(undefined))
  })

  it('returns the default when missing and a default is given', () => {
    expect(optionalString({}, 'FOO', 'fallback')).toEqual(ok('fallback'))
  })

  it('treats an empty string as missing', () => {
    expect(optionalString({ FOO: '' }, 'FOO', 'fallback')).toEqual(
      ok('fallback'),
    )
  })
})

describe('requireInt', () => {
  it('returns the parsed integer when present and valid', () => {
    expect(requireInt({ PORT: '8080' }, 'PORT')).toEqual(ok(8080))
  })

  it('errs when missing', () => {
    expect(requireInt({}, 'PORT')).toEqual(
      err('missing required environment variable: PORT'),
    )
  })

  it('errs when not an integer', () => {
    expect(requireInt({ PORT: 'abc' }, 'PORT')).toEqual(
      err('environment variable PORT must be an integer (got: abc)'),
    )
  })

  it('errs when below the configured minimum', () => {
    expect(requireInt({ PORT: '0' }, 'PORT', { min: 1 })).toEqual(
      err('environment variable PORT must be >= 1 (got: 0)'),
    )
  })

  it('errs when above the configured maximum', () => {
    expect(requireInt({ PORT: '99999' }, 'PORT', { max: 65_535 })).toEqual(
      err('environment variable PORT must be <= 65535 (got: 99999)'),
    )
  })

  it('accepts a value within the configured range', () => {
    expect(
      requireInt({ PORT: '8080' }, 'PORT', { min: 1, max: 65_535 }),
    ).toEqual(ok(8080))
  })
})

describe('optionalInt', () => {
  it('returns the default when missing', () => {
    expect(optionalInt({}, 'PORT', 8080)).toEqual(ok(8080))
  })

  it('returns the parsed integer when present and valid', () => {
    expect(optionalInt({ PORT: '3000' }, 'PORT', 8080)).toEqual(ok(3000))
  })

  it('errs when present and invalid', () => {
    expect(optionalInt({ PORT: '-1' }, 'PORT', 8080, { min: 0 })).toEqual(
      err('environment variable PORT must be >= 0 (got: -1)'),
    )
  })
})

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

describe('requireEnum', () => {
  it('returns the value when present and allowed', () => {
    expect(requireEnum({ LOG_LEVEL: 'warn' }, 'LOG_LEVEL', LOG_LEVELS)).toEqual(
      ok('warn'),
    )
  })

  it('errs when missing', () => {
    expect(requireEnum({}, 'LOG_LEVEL', LOG_LEVELS)).toEqual(
      err('missing required environment variable: LOG_LEVEL'),
    )
  })

  it('errs when present but not an allowed value', () => {
    expect(
      requireEnum({ LOG_LEVEL: 'verbose' }, 'LOG_LEVEL', LOG_LEVELS),
    ).toEqual(
      err(
        'environment variable LOG_LEVEL must be one of debug, info, warn, error (got: verbose)',
      ),
    )
  })
})

describe('optionalEnum', () => {
  it('returns the default when missing', () => {
    expect(optionalEnum({}, 'LOG_LEVEL', LOG_LEVELS, 'info')).toEqual(
      ok('info'),
    )
  })

  it('returns the value when present and allowed', () => {
    expect(
      optionalEnum({ LOG_LEVEL: 'debug' }, 'LOG_LEVEL', LOG_LEVELS, 'info'),
    ).toEqual(ok('debug'))
  })

  it('errs when present but not an allowed value', () => {
    expect(
      optionalEnum({ LOG_LEVEL: 'verbose' }, 'LOG_LEVEL', LOG_LEVELS, 'info'),
    ).toEqual(
      err(
        'environment variable LOG_LEVEL must be one of debug, info, warn, error (got: verbose)',
      ),
    )
  })
})
