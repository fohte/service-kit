import { describe, expect, it } from 'vitest'

import { redactFields } from '#logger/redact'

describe('redactFields', () => {
  it('redacts keys matching the default secret patterns at any depth, using the [REDACTED] placeholder', () => {
    const input = {
      token: 'raw',
      SLACK_BOT_TOKEN: 'xoxb-1234',
      dsn: 'https://x@y/1',
      api_key: 'sk-abc',
      authorization: 'Bearer x',
      nested: {
        accessToken: 'kept-camelCase-is-not-matched',
        OPENAI_API_KEY: 'sk-def',
        userId: 'U1',
      },
      list: [{ SENTRY_DSN: 'https://x@y/2' }, 'plain'],
      kept: 'ok',
    }

    expect(redactFields(input)).toEqual({
      token: '[REDACTED]',
      SLACK_BOT_TOKEN: '[REDACTED]',
      dsn: '[REDACTED]',
      api_key: '[REDACTED]',
      authorization: '[REDACTED]',
      nested: {
        accessToken: 'kept-camelCase-is-not-matched',
        OPENAI_API_KEY: '[REDACTED]',
        userId: 'U1',
      },
      list: [{ SENTRY_DSN: '[REDACTED]' }, 'plain'],
      kept: 'ok',
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

    const result = redactFields(input)

    expect({
      arrayHead: result.loopArray[0],
      arrayCycles: result.loopArray[1] === result.loopArray,
      objectId: result.loopObject['id'],
      objectCycles: result.loopObject['self'] === result.loopObject,
    }).toEqual({
      arrayHead: 'leaf',
      arrayCycles: true,
      objectId: 'O1',
      objectCycles: true,
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
