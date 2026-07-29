import { describe, expect, it } from 'vitest'

import { redactFields } from '#logger/redact'

describe('redactFields', () => {
  it('redacts keys matching a default secret pattern at any depth', () => {
    const input = { token: 'raw', nested: { api_key: 'sk-abc', userId: 'U1' } }

    expect(redactFields(input)).toEqual({
      token: '[REDACTED]',
      nested: { api_key: '[REDACTED]', userId: 'U1' },
    })
  })

  it('does not redact camelCase keys, since DEFAULT_SECRET_KEY_PATTERNS only matches bare or snake_case keys', () => {
    const input = { accessToken: 'kept' }

    expect(redactFields(input)).toEqual({ accessToken: 'kept' })
  })

  it('redacts array entries the same way as object fields', () => {
    const input = { list: [{ token: 'raw' }, 'plain'] }

    expect(redactFields(input)).toEqual({
      list: [{ token: '[REDACTED]' }, 'plain'],
    })
  })

  it('redacts keys matching extraSecretKeyPatterns in addition to the defaults', () => {
    const input = {
      signing_secret: 'sss',
      token: 'kept-by-override',
      kept: 'ok',
    }

    expect(
      redactFields(input, { extraSecretKeyPatterns: [/signing_secret$/i] }),
    ).toEqual({
      signing_secret: '[REDACTED]',
      token: '[REDACTED]',
      kept: 'ok',
    })
  })

  it('handles circular references in both objects and arrays without overflowing the stack', () => {
    const sharedArray: unknown[] = ['leaf']
    sharedArray.push(sharedArray)
    const sharedObject: Record<string, unknown> = { id: 'O1' }
    sharedObject['self'] = sharedObject
    const input = { loopArray: sharedArray, loopObject: sharedObject }

    const expectedArray: unknown[] = ['leaf']
    expectedArray.push(expectedArray)
    const expectedObject: Record<string, unknown> = { id: 'O1' }
    expectedObject['self'] = expectedObject

    expect(redactFields(input)).toEqual({
      loopArray: expectedArray,
      loopObject: expectedObject,
    })
  })

  it('does not mutate the input fields', () => {
    const input = { token: 'secret', nested: { api_key: 'sk-1' } }

    redactFields(input)

    expect(input).toEqual({ token: 'secret', nested: { api_key: 'sk-1' } })
  })

  it('leaves class instances (e.g. Error) intact instead of walking into them', () => {
    const err = new Error('boom')
    const input = { err, token: 'secret' }

    expect(redactFields(input)).toEqual({ err, token: '[REDACTED]' })
  })
})
