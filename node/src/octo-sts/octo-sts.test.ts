import { readFile } from 'node:fs/promises'

import type { Result } from 'neverthrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createOctoStsTokenCache, OctoStsError } from '#octo-sts/octo-sts'

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

const config = {
  url: 'https://octo-sts.example.com',
  scope: 'fohte',
  identity: 'webhook-hub-example',
  saTokenPath: '/var/run/secrets/tokens/octo-sts-token',
}

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(JSON.stringify(body)),
})

// `cause` wraps an underlying exception (JSON.parse, protobuf-es, URL) whose
// exact message isn't part of this module's contract, so it's normalized to
// a placeholder to keep this a single whole-output equality check instead of
// asserting only on `message`.
const expectOctoStsError = (
  result: Result<string, OctoStsError>,
  message: string,
  hasCause = false,
) => {
  const error = result._unsafeUnwrapErr()
  const normalized = new OctoStsError(
    error.message,
    error.cause === undefined ? undefined : '<cause>',
  )
  expect(normalized).toEqual(
    new OctoStsError(message, hasCause ? '<cause>' : undefined),
  )
}

describe('createOctoStsTokenCache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    vi.mocked(readFile).mockResolvedValue('sa-token\n')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('exchanges the SA token for a GitHub App token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ token: 'ghs_abc', expiry: '2026-01-01T01:00:00Z' }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await createOctoStsTokenCache(config).getToken()

    expect(result._unsafeUnwrap()).toBe('ghs_abc')
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://octo-sts.example.com/sts/exchange?scope=fohte&identity=webhook-hub-example',
      {
        headers: {
          authorization: 'Bearer sa-token',
          accept: 'application/json',
        },
      },
    )
  })

  it('returns the cached token without re-exchanging while well within its expiry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ token: 'ghs_abc', expiry: '2026-01-01T01:00:00Z' }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const cache = createOctoStsTokenCache(config)
    await cache.getToken()

    const result = await cache.getToken()

    expect(result._unsafeUnwrap()).toBe('ghs_abc')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('re-exchanges once the cached token enters the expiry safety margin', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          token: 'ghs_first',
          expiry: '2026-01-01T00:10:00Z',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          token: 'ghs_second',
          expiry: '2026-01-01T02:00:00Z',
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const cache = createOctoStsTokenCache(config)
    await cache.getToken()
    vi.setSystemTime(new Date('2026-01-01T00:06:00Z'))

    const result = await cache.getToken()

    expect(result._unsafeUnwrap()).toBe('ghs_second')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns an error when the SA token file is empty', async () => {
    vi.mocked(readFile).mockResolvedValue('  \n')
    vi.stubGlobal('fetch', vi.fn())

    const result = await createOctoStsTokenCache(config).getToken()

    expectOctoStsError(result, `SA token at ${config.saTokenPath} is empty`)
  })

  it('returns an error when the configured url is not a valid URL', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const result = await createOctoStsTokenCache({
      ...config,
      url: 'not-a-url',
    }).getToken()

    expectOctoStsError(result, 'invalid octo-sts url: not-a-url', true)
  })

  it('returns an error when the exchange request fails with a non-2xx status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(undefined, 401)),
    )

    const result = await createOctoStsTokenCache(config).getToken()

    expectOctoStsError(result, 'octo-sts exchange failed: HTTP 401')
  })

  it('treats a missing token field as an empty string, per proto3 field presence', async () => {
    // The proto schema has no "required" concept, so an absent `token`
    // decodes to its zero value instead of being rejected.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ expiry: '2026-01-01T01:00:00Z' })),
    )

    const result = await createOctoStsTokenCache(config).getToken()

    expect(result._unsafeUnwrap()).toBe('')
  })

  it('returns an error when the response body is not valid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('not json'),
      }),
    )

    const result = await createOctoStsTokenCache(config).getToken()

    expectOctoStsError(
      result,
      'octo-sts exchange returned malformed body',
      true,
    )
  })

  it('returns an error when expiry is not a valid RFC 3339 timestamp', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ token: 'ghs_abc', expiry: 'not-a-date' }),
        ),
    )

    const result = await createOctoStsTokenCache(config).getToken()

    expectOctoStsError(
      result,
      'octo-sts exchange returned malformed body',
      true,
    )
  })

  it('falls back to the token JWT exp claim when expiry is absent, and caches using it', async () => {
    // header: {"alg":"none"}, payload: {"iat":1767225600,"exp":1767229200}
    // (1767229200000 ms == 2026-01-01T01:00:00Z, i.e. one hour after the
    // system time set in beforeEach, well past the 5-minute safety margin)
    const jwt =
      'eyJhbGciOiJub25lIn0.eyJpYXQiOjE3NjcyMjU2MDAsImV4cCI6MTc2NzIyOTIwMH0.sig'
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ token: jwt, expiry: null }))
    vi.stubGlobal('fetch', fetchMock)
    const cache = createOctoStsTokenCache(config)
    await cache.getToken()

    const result = await cache.getToken()

    expect(result._unsafeUnwrap()).toBe(jwt)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    {
      name: 'is not a decodable JWT',
      token: 'ghs_abc',
      segments: 1,
    },
    {
      name: 'has JWT shape but an undecodable payload',
      // 2nd segment "not-json" is valid base64url but not valid JSON once decoded
      token: 'eyJhbGciOiJub25lIn0.bm90LWpzb24.sig', // gitleaks:allow
      segments: 3,
    },
    {
      name: 'has a JWT payload with no numeric exp claim',
      // header: {"alg":"none"}, payload: {"iat":1767225600} (no exp claim)
      token: 'eyJhbGciOiJub25lIn0.eyJpYXQiOjE3NjcyMjU2MDB9.sig', // gitleaks:allow
      segments: 3,
    },
  ])(
    'returns an error when expiry is absent and the token $name',
    async ({ token, segments }) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse({ token, expiry: null })),
      )

      const result = await createOctoStsTokenCache(config).getToken()

      expectOctoStsError(
        result,
        `octo-sts exchange returned no usable expiry (token segments: ${String(segments)})`,
      )
    },
  )
})
