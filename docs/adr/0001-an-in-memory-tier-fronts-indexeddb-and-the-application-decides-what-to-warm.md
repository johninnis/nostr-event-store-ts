# 1. An in-memory tier fronts IndexedDB, and the application decides what to warm

## Status

Accepted

## Context

Synchronous render paths cannot await IndexedDB, yet they need the same events the store persists: profiles, contact lists, relay lists. A store with only the durable tier would push every such read into an async path, or into a second cache each consumer keeps for itself.

Warming that memory is a policy question. Loading every stored event at `init()` delays first paint by the size of the database; loading a fixed set (the user's own replaceables, say) builds one application's idea of what matters into a library every consumer shares.

## Decision

- The store is uniformly tiered: a bounded in-memory cache in front of IndexedDB, for every event and every consumer. `peek` reads the memory tier synchronously; `query` reads memory first, then IndexedDB, and warms the memory tier with what it finds.
- `init()` opens IndexedDB and loads nothing. What is resident before first paint is the application's decision, expressed by issuing `query` at bootstrap with the filter shapes it needs; everything else warms lazily as `query` surfaces it.

## Consequences

- A consumer that wants its own replaceables resident before rendering queries for them up front; the library does not guess.
- `peek` answers only from memory, so a synchronous read before any `query` finds nothing. That is the cost of a store that loads nothing on its own.
- Requests to warm a fixed set at `init()`, or to make `init()` walk the database, are declined here: either would put one application's policy into every consumer.
