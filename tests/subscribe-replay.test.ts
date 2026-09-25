import { assertEquals } from "@std/assert"
import type { EventId, NostrEvent, NostrFilter } from "@innis/nostr-core"
import { KIND_SHORT_NOTE } from "@innis/nostr-core"
import type { EventStore } from "../src/event-store.ts"
import { buildEventFixture, buildStore, freshIdbStore, PUBKEY_A } from "./_helpers/fixtures.ts"

const KIND_INDEXED: NostrFilter = { kinds: [KIND_SHORT_NOTE] }
const FLAT_BUCKET: NostrFilter = { authors: [PUBKEY_A] }

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100))

const persistedThenCold = async (events: ReadonlyArray<NostrEvent>): Promise<{
  readonly writer: EventStore
  readonly cold: EventStore
}> => {
  const writer = await freshIdbStore()
  for (const event of events) writer.ingest(event)
  await settle()
  const cold = buildStore()
  await cold.init()
  return { writer, cold }
}

for (const [shape, filter] of [["kind-indexed", KIND_INDEXED], ["flat-bucket", FLAT_BUCKET]] as const) {
  Deno.test(`subscribe replay (${shape}) - delivers memory, then IndexedDB, then live`, async () => {
    const persisted = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A, created_at: 1000 })
    const { writer, cold } = await persistedThenCold([persisted])
    const inMemory = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A, created_at: 2000 })
    cold.ingest(inMemory)

    const delivered: Array<EventId> = []
    cold.subscribe(filter, (e) => delivered.push(e.id), { replay: true })
    assertEquals(delivered, [inMemory.id])

    await settle()
    assertEquals(delivered, [inMemory.id, persisted.id])

    const live = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A, created_at: 3000 })
    cold.ingest(live)
    assertEquals(delivered, [inMemory.id, persisted.id, live.id])

    cold.close()
    writer.close()
  })

  Deno.test(`subscribe replay (${shape}) - an event ingested mid-replay is delivered exactly once`, async () => {
    const persisted = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A })
    const { writer, cold } = await persistedThenCold([persisted])

    const delivered: Array<EventId> = []
    cold.subscribe(filter, (e) => delivered.push(e.id), { replay: true })
    cold.ingest(persisted)
    await settle()

    assertEquals(delivered, [persisted.id])
    cold.close()
    writer.close()
  })

  Deno.test(`subscribe replay (${shape}) - unsubscribing during replay stops replayed and live delivery`, async () => {
    const persisted = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A })
    const { writer, cold } = await persistedThenCold([persisted])

    const delivered: Array<EventId> = []
    const unsubscribe = cold.subscribe(filter, (e) => delivered.push(e.id), { replay: true })
    unsubscribe()
    await settle()
    cold.ingest(buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A }))

    assertEquals(delivered, [])
    cold.close()
    writer.close()
  })
}

for (const options of [undefined, { replay: false }] as const) {
  Deno.test(`subscribe - replay ${options ? "false" : "omitted"} delivers live ingests only`, async () => {
    const eventStore = buildStore()
    eventStore.ingest(buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A }))

    const delivered: Array<EventId> = []
    eventStore.subscribe(KIND_INDEXED, (e) => delivered.push(e.id), options)
    await settle()
    assertEquals(delivered, [])

    const live = buildEventFixture({ kind: KIND_SHORT_NOTE, pubkey: PUBKEY_A })
    eventStore.ingest(live)
    assertEquals(delivered, [live.id])
  })
}
