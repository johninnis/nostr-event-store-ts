# @innis/nostr-event-store

[![CI](https://github.com/johninnis/nostr-event-store-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/johninnis/nostr-event-store-ts/actions/workflows/ci.yml)

In-memory event cache plus IndexedDB-backed event store for Nostr events. One filter language (NIP-01, via `matchesFilter` from `@innis/nostr-core`) drives four evaluation modes: memory reads, IndexedDB reads, synchronous peeks, and live subscriptions.

## Install

```ts
import { createEventStore } from "@innis/nostr-event-store"

const store = createEventStore()
await store.init()
```

## Surface

`createEventStore()` — or `createEventStore({ databaseName })` to override the IndexedDB name — returns an `EventStore` with seven methods. The replaceable-event key is always `replaceableStorageKey` from `@innis/nostr-core`; there is nothing to inject.

| Method | Shape | Use for |
| ------ | ----- | ------- |
| `init()` | async | Open IndexedDB; resolve when ready. No eager walk — memory starts empty. |
| `ingest(event)` | sync, returns `boolean` | Write path: update memory and queue an IDB persist (held until `init()` opens the DB). Returns `true` if the event was newly stored, `false` if it was a duplicate or a stale replaceable. |
| `query(filter, onEvent)` | async | Memory first, then IDB. Memory hits emit synchronously; IDB hits warm the cache then emit. Deduplicated by event id. Warming a backfilled event does **not** fire `subscribe` listeners — backfill is a read, not a live ingest. |
| `peek(filter)` | sync, returns array | Memory-only sibling of `query`. Serves ids-only and all-replaceable filters from their dedicated maps; any other shape walks the in-memory cache, newest-first, honouring `limit`/`since`/`until` via `matchesFilter`. Returns `[]` for empty or `search` filters. |
| `delete(filter)` | async | Walks memory and IDB. Refuses an empty filter. Two shapes: `{ ids }` (delete by id), or any filter carrying `authors` — every event by those authors that also satisfies the rest of the filter (`kinds`, `#d`, `since`, `until`) via `matchesFilter` is removed. |
| `subscribe(filter, fn, options?)` | sync, returns unsubscribe | Fires `fn(event)` on every live `ingest` whose event matches `filter` (not on `query` backfill). Kind-indexed when `filter.kinds` is set; flat bucket otherwise. `{ replay: true }` also delivers the stored matches first — see [Replaying stored events](#replaying-stored-events). |
| `close()` | sync, idempotent | Flush pending writes, cancel the deferred-flush timer, close the IDB connection, drop subscribers. The store is inert until `init()` reopens it. |

Reads are always filter-based: to fetch by id use `peek({ ids: [...] })` or `query({ ids: [...] })` — the same filter shape as anywhere else. There is no separate id getter.

## Replaying stored events

`subscribe(filter, fn, { replay: true })` is the store's `REQ`: stored events first, then live, through one handler.

```ts
const unsubscribe = store.subscribe({ kinds: [10000], authors: [pubkey] }, applyList, { replay: true })
```

- The live listener is registered **before** the stored read starts, so nothing ingested during the read is missed.
- Stored matches are streamed exactly as `query` delivers them — memory synchronously (before `subscribe` returns), then IndexedDB. It is `query` itself, not a second read path.
- Each event id reaches `fn` **at most once** across the replay/live boundary. While the replay runs, a set of the ids delivered so far guards both sources; it is dropped when the IndexedDB pass resolves, after which `ingest`'s own dedup is the only guard the live path needs.
- Ordering: replayed events arrive in `query` order, live events as they are ingested. A live event can therefore precede an older replayed one — sort in the handler if order matters.
- Unsubscribing during the replay stops further delivery from both sources.

Without the option (or with `replay: false`) `subscribe` is live-only, as before, and `query` never notifies subscribers.

## Storage shape

- **In-memory cache** (internal, never exported) — a `byId` LRU (cap 5000) plus a `byReplaceableKey` LRU (cap 5000, read-bumped) holding the current event per replaceable key. Both tiers are bounded; anything they evict still lives in IndexedDB and is rehydrated on the next `query`. The library owns the cache; consumers reach it through `peek`/`query`/`subscribe`.
- **IndexedDB** (`nostr-events` by default; pass `databaseName` to override), schema **v1** — a single `events` object store with indices on `created_at`, `pubkey_created_at`, and `replaceable_key` (the last is `{ unique: true }`). Every read path is served by one of these three: kind filtering rides the `created_at` cursor plus `matchesFilter`, and author reads/deletes ride the `pubkey_created_at` prefix range. The schema is drop-and-recreate on any prior version — events are a cache, not the source of truth, so there is nothing to migrate.

## The invariant

For any filter `F`, `query(F, onEvent)` emits the latest matching events ever ingested into the store; `subscribe(F, fn)` fires for newer events as they arrive. Memory is always served first and the IDB pass is deduplicated by event id against it, so IDB can never overwrite a fresher in-memory answer. The IDB read each shape performs:

- **ids-only** → `byId.get(id)` per id from memory, then `store.get(id)` per id from IDB; an IDB hit for an id already served from memory is dropped by the id-dedup.
- **all-replaceable + authors** → `byReplaceableKey` per `(kind, author)` from memory, then a `get` per `(kind, author)` on the unique `replaceable_key` index; again deduplicated by id.
- **everything else** → an IDB cursor on the best index (`pubkey_created_at` when authors are present, else `created_at`), with `matchesFilter` applied per row.

## Atomic replaceable writes

Ingesting a replaceable event triggers a delete-then-put under the same `replaceable_key` within one readwrite transaction. The unique index means a stale row cannot coexist with a fresher one. The flush reads the existing row via `index.get(key)` and only deletes-then-puts when the incoming event actually supersedes it (`replaceableSupersedes`) — so the durable tier never trusts the in-memory tier blindly. An older event that slips past memory (a cold store, a cache eviction, a second tab) cannot clobber a fresher persisted row.

Within a single flush, pending events are first deduplicated by `replaceable_key` (newest wins, via `replaceableSupersedes`) before the lookups, so two events for one key never race two delete-then-put pairs.

## Why an in-memory tier

Synchronous render paths cannot await IndexedDB, yet they frequently need to read the same events the store persists — profiles, contact lists, relay lists. The in-memory cache exists to offer a synchronous read surface (`peek`) over that data; IDB is the durable tier behind it.

The store is uniformly tiered (memory → IDB) regardless of what runs on top. Whether anything is warmed before first paint is the application's decision, expressed by issuing `query` at bootstrap with the right filter shape. A consumer that wants its own replaceables resident before rendering simply queries for them up front; everything else warms lazily as the natural `query` flow surfaces it.

## Trade-offs to be aware of

- `peek(filter)` returns `ReadonlyArray<NostrEvent>` even when the caller wants a single event. `peek(...)[0] ?? null` is the canonical form for a single-value read.
- `peek` for generic filters does a linear scan of the in-memory `byId` map. There is no secondary predicate index; the scan is bounded only by the LRU cap (5000), which is acceptable for the synchronous-render shapes that motivate `peek`.
- `query` streams every matching event, deduplicated by id, **approximately** newest-first. `limit` is applied per tier (up to `limit` from memory, then up to `limit` more from IDB), so a `limit`-bounded read can over-emit, and ordering is loose at the memory/IDB seam. This suits a consumer that merges `query` with other sources (e.g. relays) and re-sorts anyway. When you need an exact, `limit`-honouring read off a single tier, use `peek`.
