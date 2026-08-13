import { afterEach, describe, expect, it, vi } from 'vitest'

import { ownSignals } from '#signal-owner'

afterEach(() => {
  process.removeAllListeners('SIGTERM')
  process.removeAllListeners('SIGINT')
})

describe('ownSignals', () => {
  it('registers the handler as a SIGTERM and SIGINT listener', () => {
    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    }

    ownSignals(() => {})

    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1)
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1)
  })

  it('removes both listeners when detach is called', () => {
    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    }
    const { detach } = ownSignals(() => {})

    detach()

    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm)
    expect(process.listenerCount('SIGINT')).toBe(before.sigint)
  })

  it('invokes the handler with the delivered signal', () => {
    const onSignal = vi.fn()
    ownSignals(onSignal)

    process.emit('SIGTERM', 'SIGTERM')

    expect(onSignal.mock.calls).toEqual([['SIGTERM']])
  })
})
