// Node's ESM loader bypasses `require()`, so `@opentelemetry/instrumentation`'s
// module-patching (used by instrumentation-http and friends to create spans
// for built-in modules like `http`) never runs against `import`ed modules
// unless this loader hook is registered before the app itself loads — without
// it, `http.Server` is never patched and no server-side spans are created.
// https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md
import { register as registerAsync } from 'node:module'

import {
  register as registerSync,
  supportsSyncHooks,
} from 'import-in-the-middle/register-hooks.mjs'

if (supportsSyncHooks()) {
  // ESM-only instrumentation for modules outside this list is not applied.
  registerSync({
    include: ['http', 'https', 'node:http', 'node:https'],
  })
} else {
  // Anchor resolution to this file so pnpm's strict node_modules can resolve
  // service-kit dependencies without requiring consumers to declare them.
  registerAsync('@opentelemetry/instrumentation/hook.mjs', import.meta.url)
}
