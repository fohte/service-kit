import { beforeEach, describe, expect, it, vi } from 'vitest'

interface CapturedScopeCalls {
  fingerprints: unknown[]
  levels: unknown[]
  tags: Record<string, unknown>
  extras: Record<string, unknown>
  errors: unknown[]
}

const captured: CapturedScopeCalls = {
  fingerprints: [],
  levels: [],
  tags: {},
  extras: {},
  errors: [],
}

const scope = {
  setFingerprint: (fp: unknown) => {
    captured.fingerprints.push(fp)
    return scope
  },
  setLevel: (level: unknown) => {
    captured.levels.push(level)
    return scope
  },
  setTag: (key: string, value: unknown) => {
    captured.tags[key] = value
    return scope
  },
  setExtra: (key: string, value: unknown) => {
    captured.extras[key] = value
    return scope
  },
}

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  withScope: (cb: (s: typeof scope) => unknown) => cb(scope),
  captureException: (err: unknown) => {
    captured.errors.push(err)
    return 'event-id'
  },
}))

const { captureWithFingerprint, initSentry, isSentryConfigured, redactEvent } =
  await import('@/observability/sentry')

beforeEach(() => {
  captured.fingerprints = []
  captured.levels = []
  captured.tags = {}
  captured.extras = {}
  captured.errors = []
})

describe('isSentryConfigured', () => {
  it('returns based on SENTRY_DSN presence', () => {
    expect({
      withDsn: isSentryConfigured({ SENTRY_DSN: 'https://x@y/1' }),
      emptyDsn: isSentryConfigured({ SENTRY_DSN: '' }),
      blankDsn: isSentryConfigured({ SENTRY_DSN: '   ' }),
      missing: isSentryConfigured({}),
    }).toEqual({
      withDsn: true,
      emptyDsn: false,
      blankDsn: false,
      missing: false,
    })
  })
})

describe('initSentry', () => {
  it('returns undefined when SENTRY_DSN is missing', () => {
    expect(initSentry({})).toBeUndefined()
  })
})

describe('redactEvent', () => {
  it('redacts authorization header and secret-like keys across all event containers with the default patterns', () => {
    const input = {
      request: {
        headers: {
          Authorization: 'Bearer secret-token',
          'content-type': 'application/json',
        },
      },
      contexts: {
        slack: {
          channel: 'C123',
          nested: {
            SLACK_BOT_TOKEN: 'xoxb-1234',
            user_id: 'U123',
          },
        },
      },
      tags: {
        request_id: 'req-1',
        api_token: 'tok-secret',
      },
      user: {
        id: 'U1',
        api_key: 'sk-1',
      },
      extra: {
        SENTRY_DSN: 'https://x@y/1',
        OPENAI_API_KEY: 'sk-abc',
        access_token: 'xoxb-lower',
        otherTags: ['ok'],
      },
      breadcrumbs: [
        {
          category: 'http',
          data: { Authorization: 'Bearer x', url: 'https://api/' },
        },
      ],
    }

    expect(redactEvent(input)).toEqual({
      request: {
        headers: {
          Authorization: '[REDACTED]',
          'content-type': 'application/json',
        },
      },
      contexts: {
        slack: {
          channel: 'C123',
          nested: {
            SLACK_BOT_TOKEN: '[REDACTED]',
            user_id: 'U123',
          },
        },
      },
      tags: {
        request_id: 'req-1',
        api_token: '[REDACTED]',
      },
      user: {
        id: 'U1',
        api_key: '[REDACTED]',
      },
      extra: {
        SENTRY_DSN: '[REDACTED]',
        OPENAI_API_KEY: '[REDACTED]',
        access_token: '[REDACTED]',
        otherTags: ['ok'],
      },
      breadcrumbs: [
        {
          category: 'http',
          data: { Authorization: '[REDACTED]', url: 'https://api/' },
        },
      ],
    })
  })

  it('routes request.headers through secretPatterns so extra patterns redact headers too', () => {
    const input = {
      request: {
        headers: {
          Authorization: 'Bearer x',
          'X-Api-Token': 'tok',
          'content-type': 'application/json',
        },
      },
    }

    expect(
      redactEvent(input, {
        extraSecretKeyPatterns: [/^x-api-token$/i],
      }),
    ).toEqual({
      request: {
        headers: {
          Authorization: '[REDACTED]',
          'X-Api-Token': '[REDACTED]',
          'content-type': 'application/json',
        },
      },
    })
  })

  it('redacts values whose key matches extraSecretKeyPatterns in addition to the defaults', () => {
    const input = {
      extra: {
        slack_signing_secret: 'sss',
        SENTRY_DSN: 'dsn',
        kept: 'ok',
      },
    }

    expect(
      redactEvent(input, {
        extraSecretKeyPatterns: [/signing_secret$/i],
      }),
    ).toEqual({
      extra: {
        slack_signing_secret: '[REDACTED]',
        SENTRY_DSN: '[REDACTED]',
        kept: 'ok',
      },
    })
  })

  it('truncates string values whose key matches an extraStringTruncators entry', () => {
    const longMessage = 'a'.repeat(250)
    const input = {
      contexts: {
        slack: {
          message: longMessage,
          channel: 'C123',
        },
      },
    }

    expect(
      redactEvent(input, {
        extraStringTruncators: [
          { pattern: /^(slack_)?message(_text|_body)?$/i, maxLength: 200 },
        ],
      }),
    ).toEqual({
      contexts: {
        slack: {
          message: 'a'.repeat(200),
          channel: 'C123',
        },
      },
    })
  })

  it('leaves strings shorter than maxLength untouched', () => {
    const input = {
      contexts: {
        slack: { message: 'short' },
      },
    }

    expect(
      redactEvent(input, {
        extraStringTruncators: [{ pattern: /^message$/i, maxLength: 200 }],
      }),
    ).toEqual({
      contexts: {
        slack: { message: 'short' },
      },
    })
  })

  it('prefers redaction over truncation when both patterns match the same key', () => {
    const input = {
      extra: {
        api_key: 'sk-' + 'a'.repeat(300),
      },
    }

    expect(
      redactEvent(input, {
        extraStringTruncators: [{ pattern: /api_key/i, maxLength: 5 }],
      }),
    ).toEqual({
      extra: {
        api_key: '[REDACTED]',
      },
    })
  })

  it('handles circular references in both objects and arrays without overflowing the stack', () => {
    const sharedArray: unknown[] = ['leaf']
    sharedArray.push(sharedArray)
    const sharedObject: Record<string, unknown> = { id: 'O1' }
    sharedObject['self'] = sharedObject
    const input = {
      extra: {
        loopArray: sharedArray,
        loopObject: sharedObject,
      },
    }

    const result = redactEvent(input)

    expect({
      arrayHead: result.extra.loopArray[0],
      arrayCycles: result.extra.loopArray[1] === result.extra.loopArray,
      objectId: result.extra.loopObject['id'],
      objectCycles: result.extra.loopObject['self'] === result.extra.loopObject,
    }).toEqual({
      arrayHead: 'leaf',
      arrayCycles: true,
      objectId: 'O1',
      objectCycles: true,
    })
  })

  it('does not mutate the input event', () => {
    const input = {
      request: { headers: { Authorization: 'Bearer x' } },
      extra: { SENTRY_DSN: 'dsn' },
    }
    redactEvent(input)
    expect(input).toEqual({
      request: { headers: { Authorization: 'Bearer x' } },
      extra: { SENTRY_DSN: 'dsn' },
    })
  })
})

describe('captureWithFingerprint', () => {
  it('forwards the error to Sentry with the fingerprint, level, tags, and extras from context', () => {
    const err = new Error('boom')
    captureWithFingerprint(err, 'opencode-go-usage-limit', {
      level: 'warning',
      tags: {
        error_type: 'GoUsageLimitError',
        retry_after_seconds: '42',
      },
      extras: { request_id: 'req-1' },
    })

    expect(captured).toEqual({
      fingerprints: [['opencode-go-usage-limit']],
      levels: ['warning'],
      tags: {
        error_type: 'GoUsageLimitError',
        retry_after_seconds: '42',
      },
      extras: { request_id: 'req-1' },
      errors: [err],
    })
  })

  it('accepts an array fingerprint and omits optional scope fields', () => {
    const err = new Error('boom')
    captureWithFingerprint(err, ['service', 'kind-x'])

    expect(captured).toEqual({
      fingerprints: [['service', 'kind-x']],
      levels: [],
      tags: {},
      extras: {},
      errors: [err],
    })
  })
})
