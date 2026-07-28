import { describe, expect, it, vi } from 'vitest'

const { registerMock } = vi.hoisted(() => ({
  registerMock: vi.fn(),
}))

vi.mock('node:module', () => ({ register: registerMock }))

await import('./otel-register')

describe('otel-register', () => {
  it('registers the @opentelemetry/instrumentation ESM loader hook anchored to this file', () => {
    expect(registerMock.mock.calls).toEqual([
      [
        '@opentelemetry/instrumentation/hook.mjs',
        new URL('./otel-register.ts', import.meta.url).href,
      ],
    ])
  })
})
