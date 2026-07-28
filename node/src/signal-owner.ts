export interface SignalOwnerHandle {
  readonly detach: () => void
}

// Node invokes every listener registered for a signal, so two independent
// SIGTERM/SIGINT handlers race with no ordering guarantee between them.
// Callers that need a single, well-ordered shutdown sequence share this one
// registration instead of calling `process.once` themselves.
export const ownSignals = (
  onSignal: (signal: NodeJS.Signals) => void,
): SignalOwnerHandle => {
  // Use `once` (not `on`) so a second delivery after `detach()` falls through
  // to Node's default handler.
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
  return {
    detach: () => {
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
    },
  }
}
