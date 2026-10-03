# 0. Record architecture decisions

## Status

Accepted

## Context

Architectural decisions and the reasoning behind them are easily lost. Once the rationale is gone, a later reader cannot tell a deliberate choice from an accident, and "corrects" a design that was right, reintroducing the bug it was written to avoid.

The rationale must travel with the repository and be the first thing a reviewer reads. The `README.md` explains how to use the package, not why it is shaped the way it is.

## Decision

We record architecture decisions in immutable, sequentially numbered records under `docs/adr/`, following Michael Nygard's convention. Each record has exactly four sections: **Status**, **Context**, **Decision**, **Consequences**.

A record is never edited to change its decision; it is superseded by a later record, and its Status is set to `Superseded by ADR-NNNN`.

Where a decision reads like a smell at the call site, the code carries a one-line comment pointing at the record (`// Deliberate: … — see ADR-NNNN`), backed by a test that fails if the design is undone.

A record's filename is its four-digit number and a kebab-case slug of its title, at most 95 characters including the `.md` extension, the longest path component JSR accepts. A longer title is shortened in the filename, never in the record's heading.

## Consequences

- Design rationale lives in `docs/adr/`, alongside the code. It is not inlined into the `README.md`.
- A reviewer reads `docs/adr/` before judging the code, and does not "fix" anything a record justifies. Disagreement is expressed by superseding a record.
- Plain NIP compliance needs no record; every choice the NIPs leave open does.
