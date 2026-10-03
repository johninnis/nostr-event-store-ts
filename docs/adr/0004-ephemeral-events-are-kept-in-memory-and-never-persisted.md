# 4. Ephemeral events are kept in memory and never persisted

## Status

Accepted

## Context

NIP-01 defines kinds 20000–29999 as ephemeral: "not expected to be stored by relays". They carry momentary state (typing indicators, auth challenges, ephemeral gift wraps) that is meaningless after the session that saw it. Writing them to IndexedDB costs a write per event and leaves rows nothing will ever usefully read, yet the application still needs to see them through the same `subscribe` and `peek` surface as every other event. NDK's cache adapters likewise skip ephemeral kinds when persisting.

## Decision

- `ingest` treats an ephemeral event (by core's `kindCategory`) like any other in memory: it is deduplicated, cached, and delivered to subscribers.
- It is never queued for the IndexedDB flush.

## Consequences

- An ephemeral event is readable through `peek`, `query` and `subscribe` until the in-memory LRU evicts it or the page unloads, and is never readable from a cold store.
- The IndexedDB tier holds only kinds a relay would store.
