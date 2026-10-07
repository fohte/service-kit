import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SyncHooksApi } from '#otel-register-registration'
import { registerOtelHooks } from '#otel-register-registration'

const { asyncRegisterMock, syncRegisterMock, supportsSyncHooksMock } =
  vi.hoisted(() => ({
    asyncRegisterMock: vi.fn(),
    syncRegisterMock: vi.fn(),
    supportsSyncHooksMock: vi.fn(),
  }))

vi.mock('node:module', () => ({ register: asyncRegisterMock }))

function registrationCalls() {
  return [
    asyncRegisterMock.mock.calls,
    supportsSyncHooksMock.mock.calls,
    syncRegisterMock.mock.calls,
  ]
}

describe('otel-register', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it.each([
    {
      runtime: 'supports synchronous hooks',
      supportsSyncHooks: true,
      expected: [
        [],
        [[]],
        [[{ include: ['http', 'https', 'node:http', 'node:https'] }]],
      ],
    },
    {
      runtime: 'does not support synchronous hooks',
      supportsSyncHooks: false,
      expected: [
        [
          [
            '@opentelemetry/instrumentation/hook.mjs',
            new URL('./otel-register.ts', import.meta.url).href,
          ],
        ],
        [[]],
        [],
      ],
    },
    {
      runtime: 'does not provide the synchronous hook API',
      supportsSyncHooks: undefined,
      expected: [
        [
          [
            '@opentelemetry/instrumentation/hook.mjs',
            new URL('./otel-register.ts', import.meta.url).href,
          ],
        ],
        [],
        [],
      ],
    },
  ])('$runtime', ({ supportsSyncHooks, expected }) => {
    const syncHooksApi: SyncHooksApi | undefined =
      supportsSyncHooks === undefined
        ? undefined
        : {
            register: syncRegisterMock,
            supportsSyncHooks: supportsSyncHooksMock,
          }

    if (supportsSyncHooks !== undefined) {
      supportsSyncHooksMock.mockReturnValue(supportsSyncHooks)
    }

    registerOtelHooks(
      syncHooksApi,
      new URL('./otel-register.ts', import.meta.url).href,
    )

    expect(registrationCalls()).toEqual(expected)
  })
})
