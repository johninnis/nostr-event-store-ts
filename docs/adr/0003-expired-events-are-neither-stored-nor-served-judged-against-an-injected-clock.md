# 3. Expired events are neither stored nor served, judged against an injected clock

## Status

Accepted

## Context

NIP-40 lets an event carry an `expiration` tag. Relays "SHOULD drop any events that are published to them if they are expired" and "SHOULD NOT send expired events to clients, even if they are stored"; clients "SHOULD ignore events that have expired". The store sits between the two: relays write into it and the application reads out of it. An event that is fresh when ingested can expire while it sits in memory or IndexedDB, so a check on write alone is not enough.

`@innis/nostr-core` already decides what "expired" means (`isEventExpired`: expired once any well-formed `expiration` tag is at or before the given time) and how time is modelled (`Clock`, defaulting to `now`, injected as an optional `clock` on the services that judge time — nostr-core ADR-0007; the any-expiry rule is shared ADR-0011).

## Decision

- `createEventStore` takes an optional `clock: Clock`, defaulting to core's `now`.
- `ingest` returns `false` for an event expired at `clock()`: it is not cached, persisted, or delivered to subscribers.
- Every read (`peek`, `query`'s memory pass and its IndexedDB pass, and therefore `subscribe` replay) skips an event expired at the time the read starts. An expired IndexedDB row does not count towards `limit`.
- Expiry is judged only by core's `isEventExpired`; the store has no rule of its own.
- Expired events are not swept: they stay until LRU eviction, an overwrite, or `delete`. Reads never return them.

## Consequences

- No caller has to filter expired events out of what the store returns.
- Tests drive expiry by passing a clock instead of faking `Date`.
- IndexedDB can hold dead rows until something removes them; a sweep would be a separate decision.
