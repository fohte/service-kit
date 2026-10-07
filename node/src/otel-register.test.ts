import { beforeEach, describe, expect, it, vi } from 'vitest'

const { asyncRegisterMock, syncRegisterMock, supportsSyncHooksMock } =
  vi.hoisted(() => ({
    asyncRegisterMock: vi.fn(),
    syncRegisterMock: vi.fn(),
    supportsSyncHooksMock: vi.fn(),
  }))

vi.mock('node:module', () => ({ register: asyncRegisterMock }))
vi.mock('import-in-the-middle/register-hooks.mjs', () => ({
  register: syncRegisterMock,
  supportsSyncHooks: supportsSyncHooksMock,
}))

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
  ])('$runtime', async ({ supportsSyncHooks, expected }) => {
    supportsSyncHooksMock.mockReturnValue(supportsSyncHooks)

    await import('./otel-register')

    expect(registrationCalls()).toEqual(expected)
  })
})
