import { register as registerAsync } from 'node:module'

export type SyncHooksApi = {
  register(options: { include: string[] }): void
  supportsSyncHooks(): boolean
}

export function registerOtelHooks(
  syncHooksApi: SyncHooksApi | undefined,
  parentURL: string,
): void {
  if (syncHooksApi?.supportsSyncHooks() === true) {
    syncHooksApi.register({
      include: ['http', 'https', 'node:http', 'node:https'],
    })
    return
  }

  registerAsync('@opentelemetry/instrumentation/hook.mjs', parentURL)
}
