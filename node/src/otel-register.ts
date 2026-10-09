// Node's ESM loader bypasses `require()`, so `@opentelemetry/instrumentation`'s
// module-patching (used by instrumentation-http and friends to create spans
// for built-in modules like `http`) never runs against `import`ed modules
// unless this loader hook is registered before the app itself loads — without
// it, `http.Server` is never patched and no server-side spans are created.
// https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { Result, ResultAsync } from 'neverthrow'

import {
  registerOtelHooks,
  type SyncHooksApi,
} from './otel-register-registration.js'

function isSyncHooksApi(value: unknown): value is SyncHooksApi {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  return (
    'register' in value &&
    typeof value.register === 'function' &&
    'supportsSyncHooks' in value &&
    typeof value.supportsSyncHooks === 'function'
  )
}

const syncHooksEntryPath = Result.fromThrowable(
  () => {
    const instrumentationEntryPath = createRequire(import.meta.url).resolve(
      '@opentelemetry/instrumentation',
    )

    // OTel Hook instances and the synchronous hook must share the same registry.
    return createRequire(instrumentationEntryPath).resolve(
      'import-in-the-middle/register-hooks.mjs',
    )
  },
  () => undefined,
)().unwrapOr(undefined)

const syncHooksApi =
  syncHooksEntryPath === undefined
    ? undefined
    : await ResultAsync.fromPromise(
        import(pathToFileURL(syncHooksEntryPath).href),
        () => undefined,
      )
        .map((module): SyncHooksApi | undefined =>
          isSyncHooksApi(module) ? module : undefined,
        )
        .unwrapOr(undefined)

registerOtelHooks(syncHooksApi, import.meta.url)
