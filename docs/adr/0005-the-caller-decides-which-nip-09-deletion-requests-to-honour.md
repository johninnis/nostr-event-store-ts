# 5. The caller decides which NIP-09 deletion requests to honour

## Status

Accepted

## Context

NIP-09 kind-5 events request the deletion of earlier events. Relays "SHOULD delete or stop publishing" the referenced events with an identical `pubkey`; clients "SHOULD hide or otherwise indicate a deletion request status", "MAY choose to fully hide" them, and "MUST validate that each event `pubkey` referenced ... is identical to the deletion request `pubkey`, before hiding or deleting any event". Whether to hide, mark, or keep a deleted event is a presentation choice, and honouring one correctly needs the author check, the `a`-tag `created_at` bound, and possibly the referenced event itself, which may not be in the store yet.

The store is a cache of what the application has seen, not the source of truth. Applying deletion requests inside `ingest` would make that choice for every application and couple a cache to a policy.

## Decision

- The store does not interpret kind-5 events: it stores them like any other regular event.
- An application that honours a deletion request validates it and calls `delete` with a filter naming the events to remove (`{ ids, authors }`, or `{ kinds, authors, "#d", until }` for an `a` tag).

## Consequences

- Each application chooses hide, mark, or remove, and the store never removes an event the application wanted to show.
- An application that wants relay-like behaviour must wire it itself; `delete` already takes the filter shapes it needs.
