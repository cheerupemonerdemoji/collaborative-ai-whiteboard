# ADR 003: Append-oriented board history with checkpoints

- Status: Accepted
- Date: 2026-09-14

## Problem

The application must show who changed what and when, efficiently view an older board, and safely restore it without discarding later history.

## Alternatives

- Save a full board copy after every update.
- Treat tldraw's current-state database or client undo stack as history.
- Store committed record changes plus periodic full checkpoints.

## Decision

Keep immutable user-facing events and checkpoints in each board's existing SQLite file. Capture full before/after values for changed records, combine rapid updates from the same authenticated session into semantic events, and create periodic or explicit checkpoints. Reconstruct from the nearest checkpoint plus subsequent validated changes. A restore saves the live head, performs an optimistic clock check, applies the historical state, and appends new restore events.

## Consequences

Historical reads are efficient without one snapshot per pointer frame, and restores are reversible. History and tldraw state share the same backup unit. The deployment remains limited to a single Node writer per board.
