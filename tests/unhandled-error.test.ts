import { assertStrictEquals } from "@std/assert"
import { reportUnhandledError } from "../src/unhandled-error.ts"

Deno.test("reportUnhandledError - re-throws the error to the host's unhandled-error handling", async () => {
  const fault = new Error("fault with no caller")
  const reported = new Promise<unknown>((resolve) => {
    const onError = (event: ErrorEvent): void => {
      event.preventDefault()
      globalThis.removeEventListener("error", onError)
      resolve(event.error)
    }
    globalThis.addEventListener("error", onError)
  })
  reportUnhandledError(fault)
  assertStrictEquals(await reported, fault)
})
