/** A callable scheduler that can also be cancelled before its pending invocation fires. */
export interface CancellableScheduler {
  (): void
  readonly cancel: () => void
}

/**
 * Fire `fn` once `ms` after the first call of a burst; calls made while a fire is pending are
 * dropped. Used to collapse a flurry of triggers into a single deferred flush.
 */
export const coalesce = (fn: () => void, ms: number): CancellableScheduler => {
  let handle: ReturnType<typeof setTimeout> | null = null
  const scheduler = (): void => {
    if (handle !== null) return
    handle = setTimeout(() => {
      handle = null
      fn()
    }, ms)
  }
  const cancel = (): void => {
    if (handle === null) return
    clearTimeout(handle)
    handle = null
  }
  return Object.assign(scheduler, { cancel })
}
