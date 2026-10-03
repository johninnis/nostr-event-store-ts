/** Re-throw `error` in a microtask, so a fault with no caller to reach surfaces to the host's unhandled-error handling. */
export const reportUnhandledError = (error: unknown): void => {
  queueMicrotask(() => {
    throw error
  })
}
