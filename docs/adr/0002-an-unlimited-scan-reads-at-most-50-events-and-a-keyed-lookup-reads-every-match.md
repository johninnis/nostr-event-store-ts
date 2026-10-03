# 2. An unlimited scan reads at most 50 events, and a keyed lookup reads every match

## Status

Accepted

## Context

NIP-01 says what `limit` means when a filter carries one: the newest `n` matches, lowest id first on a `created_at` tie, and nothing at all for `limit: 0`. It leaves open what a store returns when the filter carries none. A relay answers with its own cap; a store inside the client has to choose one too, because both `peek` and `query` hand their results to synchronous code.

The filter shapes differ in what an unlimited read costs. An `ids` lookup or a replaceable lookup (`kinds` all replaceable, plus `authors`) names its own candidates: it can match at most one event per id or per `(kind, author)`, so the caller has already bounded it. A scan (any other shape) walks the in-memory cache or an IndexedDB cursor, and without a cap returns every stored event of a kind, which on a long-lived database is unbounded work on a render path.

## Decision

- A filter's `limit`, when present, applies to every shape, in NIP-01 order, and `0` reads nothing.
- Without a `limit`, a scan reads at most 50 events, newest first, and an `ids` or replaceable lookup reads every match.
- The rule is one function, `readLimit`, used by both `peek` and the IndexedDB read.

## Consequences

- A caller that needs more than 50 events from a scan says so with `limit`.
- A caller that names 200 ids gets all 200 back without having to repeat the count as a `limit`.
- Changing the default cap changes `peek` and `query` together.
