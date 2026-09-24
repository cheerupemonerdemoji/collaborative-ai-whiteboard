# ADR 001: Node and SQLite are the canonical production path

- Status: Accepted
- Date: 2026-09-09

## Problem

The whiteboard needs durable room state on `your-server`, live tldraw synchronization, simple backups, and private access through Tailscale.

## Alternatives

- Continue using the existing Cloudflare Worker, Durable Object SQLite, and R2 deployment.
- Run the official tldraw synchronization stack in Node with local SQLite files.

## Decision

Use Node 22, Fastify, `TLSocketRoom`, `SQLiteSyncStorage`, `NodeSqliteWrapper`, and one persistent SQLite file per room. Bind the application to localhost and publish it only through Tailscale Serve. Preserve the Cloudflare implementation at the `cloudflare-v1-working` Git tag.

## Consequences

Operations and backups are straightforward and data stays on the home server. The supported concurrency boundary is one Node process per room. Cloudflare remains a recovery path rather than a second writable source of truth.
