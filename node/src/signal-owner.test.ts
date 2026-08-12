import { afterEach, describe, expect, it, vi } from 'vitest'

import { ownSignals } from '#signal-owner'

const listenerCounts = () => ({
  sigterm: process.listenerCount('SIGTERM'),
  sigint: process.listenerCount('SIGINT'),
})

afterEach(() => {
  process.removeAllListeners('SIGTERM')
  process.removeAllListeners('SIGINT')
})

describe('ownSignals', () => {
  it('registers the handler as a SIGTERM and SIGINT listener', () => {
    const before = listenerCounts()

    ownSignals(() => {})

    expect(listenerCounts()).toEqual({
      sigterm: before.sigterm + 1,
      sigint: before.sigint + 1,
    })
  })

  it('removes both listeners when detach is called', () => {
    const before = listenerCounts()
    const { detach } = ownSignals(() => {})

    detach()

    expect(listenerCounts()).toEqual(before)
  })

  it('invokes the handler with the delivered signal', () => {
    const onSignal = vi.fn()
    ownSignals(onSignal)

    process.emit('SIGTERM', 'SIGTERM')

    expect(onSignal.mock.calls).toEqual([['SIGTERM']])
  })
})
