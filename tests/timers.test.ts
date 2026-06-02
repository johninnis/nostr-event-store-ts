import { assertEquals } from "@std/assert"
import { coalesce } from "../src/timers.ts"

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

Deno.test("coalesce - first call schedules, subsequent calls drop until it fires", async () => {
  let count = 0
  const fn = coalesce(() => {
    count++
  }, 30)
  fn()
  fn()
  fn()
  assertEquals(count, 0)
  await wait(60)
  assertEquals(count, 1)
  fn()
  await wait(60)
  assertEquals(count, 2)
})

Deno.test("coalesce - cancel prevents the pending fire", async () => {
  let count = 0
  const fn = coalesce(() => {
    count++
  }, 30)
  fn()
  fn.cancel()
  await wait(60)
  assertEquals(count, 0)
})
