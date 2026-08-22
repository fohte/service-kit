import { readFile } from 'node:fs/promises'

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

    expect(result._unsafeUnwrapErr()).toEqual(
      new OctoStsError(`SA token at ${config.saTokenPath} is empty`, undefined),
    )
  })

  it('returns an error when the exchange request fails with a non-2xx status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(undefined, 401)),
    )

    const result = await createOctoStsTokenCache(config).getToken()

    expect(result._unsafeUnwrapErr()).toEqual(
      new OctoStsError('octo-sts exchange failed: HTTP 401', undefined),
    )
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

    const error = result._unsafeUnwrapErr()
    expect(error).toBeInstanceOf(OctoStsError)
    expect(error.message).toBe('octo-sts exchange returned malformed body')
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

    const error = result._unsafeUnwrapErr()
    expect(error).toBeInstanceOf(OctoStsError)
    expect(error.message).toBe('octo-sts exchange returned malformed body')
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

  it('returns an error when expiry is absent and the token is not a decodable JWT', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ token: 'ghs_abc', expiry: null })),
    )

    const result = await createOctoStsTokenCache(config).getToken()

    expect(result._unsafeUnwrapErr()).toEqual(
      new OctoStsError(
        'octo-sts exchange returned no usable expiry (token segments: 1)',
        undefined,
      ),
    )
  })

  it('returns an error when expiry is absent and the token has JWT shape but an undecodable payload', async () => {
    // 2nd segment "not-json" is valid base64url but not valid JSON once decoded
    const jwt = 'eyJhbGciOiJub25lIn0.bm90LWpzb24.sig'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ token: jwt, expiry: null })),
    )

    const result = await createOctoStsTokenCache(config).getToken()

    expect(result._unsafeUnwrapErr()).toEqual(
      new OctoStsError(
        'octo-sts exchange returned no usable expiry (token segments: 3)',
        undefined,
      ),
    )
  })

  it('returns an error when expiry is absent and the token JWT payload has no numeric exp claim', async () => {
    // header: {"alg":"none"}, payload: {"iat":1767225600} (no exp claim)
    const jwt = 'eyJhbGciOiJub25lIn0.eyJpYXQiOjE3NjcyMjU2MDB9.sig'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ token: jwt, expiry: null })),
    )

    const result = await createOctoStsTokenCache(config).getToken()

    expect(result._unsafeUnwrapErr()).toEqual(
      new OctoStsError(
        'octo-sts exchange returned no usable expiry (token segments: 3)',
        undefined,
      ),
    )
  })
})
