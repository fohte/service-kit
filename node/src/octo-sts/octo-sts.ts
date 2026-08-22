import { readFile } from 'node:fs/promises'

import { fromJsonString } from '@bufbuild/protobuf'
import { timestampDate } from '@bufbuild/protobuf/wkt'
import { errAsync, okAsync, Result, ResultAsync } from 'neverthrow'

import { BoundaryError } from '../errors'
import type { RawToken } from './gen/platform/oidc/v1/oidc.platform_pb'
import { RawTokenSchema } from './gen/platform/oidc/v1/oidc.platform_pb'

export class OctoStsError extends BoundaryError {}

export interface OctoStsConfig {
  url: string
  scope: string
  identity: string
  saTokenPath: string
}

export interface OctoStsTokenCache {
  getToken(): ResultAsync<string, OctoStsError>
}

interface CachedToken {
  token: string
  expiresAtMs: number
}

// Refresh this far ahead of the reported expiry so a token handed to a
// caller is never used right at the edge of validity.
const SAFETY_MARGIN_MS = 5 * 60 * 1000

// octo-sts's `Exchange` only ever sets `token` on the response (confirmed by
// hitting the live endpoint), so `expiry` comes back absent and the expiry
// must be derived from the `exp` claim on the token itself, which is a JWT.
const expiryFromJwt = (token: string): number | null => {
  const payloadSegment = token.split('.')[1]
  if (payloadSegment === undefined) {
    return null
  }
  const parsed = Result.fromThrowable(
    (segment: string): unknown =>
      JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8')),
    () => undefined,
  )(payloadSegment)
  if (parsed.isErr()) {
    return null
  }
  const payload = parsed.value
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('exp' in payload) ||
    typeof payload.exp !== 'number'
  ) {
    return null
  }
  return payload.exp * 1000
}

const resolveExpiryMs = (raw: RawToken): number | null => {
  if (raw.expiry !== undefined) {
    return timestampDate(raw.expiry).getTime()
  }
  return expiryFromJwt(raw.token)
}

export const createOctoStsTokenCache = (
  config: OctoStsConfig,
): OctoStsTokenCache => {
  let cached: CachedToken | null = null

  const exchange = (): ResultAsync<CachedToken, OctoStsError> =>
    ResultAsync.fromPromise(
      readFile(config.saTokenPath, 'utf-8'),
      (cause) =>
        new OctoStsError(
          `failed to read SA token at ${config.saTokenPath}`,
          cause,
        ),
    )
      .map((raw) => raw.trim())
      .andThen((saToken) => {
        if (saToken === '') {
          return errAsync(
            new OctoStsError(
              `SA token at ${config.saTokenPath} is empty`,
              undefined,
            ),
          )
        }
        return Result.fromThrowable(
          () => {
            const url = new URL('/sts/exchange', config.url)
            url.searchParams.set('scope', config.scope)
            url.searchParams.set('identity', config.identity)
            return url
          },
          (cause) =>
            new OctoStsError(`invalid octo-sts url: ${config.url}`, cause),
        )().asyncAndThen((url) =>
          ResultAsync.fromPromise(
            fetch(url.toString(), {
              headers: {
                authorization: `Bearer ${saToken}`,
                accept: 'application/json',
              },
            }),
            (cause) =>
              new OctoStsError('octo-sts exchange network error', cause),
          ),
        )
      })
      .andThen((res) => {
        if (!res.ok) {
          return errAsync(
            new OctoStsError(
              `octo-sts exchange failed: HTTP ${String(res.status)}`,
              undefined,
            ),
          )
        }
        return ResultAsync.fromPromise(
          res.text(),
          (cause) =>
            new OctoStsError(
              'octo-sts exchange returned malformed body',
              cause,
            ),
        )
      })
      .andThen((text) =>
        Result.fromThrowable(
          (raw: string) =>
            fromJsonString(RawTokenSchema, raw, {
              ignoreUnknownFields: true,
            }),
          (cause) =>
            new OctoStsError(
              'octo-sts exchange returned malformed body',
              cause,
            ),
        )(text),
      )
      .andThen((raw) => {
        const expiresAtMs = resolveExpiryMs(raw)
        if (expiresAtMs === null) {
          return errAsync(
            new OctoStsError(
              // The token itself isn't included: it's still a live credential
              // at this point, and this error path is expected to reach Sentry.
              `octo-sts exchange returned no usable expiry (token segments: ${String(raw.token.split('.').length)})`,
              undefined,
            ),
          )
        }
        return okAsync({ token: raw.token, expiresAtMs })
      })

  return {
    // ponytail: no in-flight dedup -- a duplicate exchange on a concurrent
    // cache miss is cheap at the call volumes this cache is built for. Add
    // dedup if octo-sts load ever becomes a problem.
    getToken: () => {
      if (
        cached !== null &&
        cached.expiresAtMs - Date.now() > SAFETY_MARGIN_MS
      ) {
        return okAsync(cached.token)
      }
      return exchange().map((entry) => {
        cached = entry
        return entry.token
      })
    },
  }
}
