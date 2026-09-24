# ADR 002: Local accounts, server sessions, and board roles

- Status: Accepted
- Date: 2026-09-14

## Problem

Tailscale identifies an allowed device but does not provide application users, board ownership, collaborator roles, or per-room WebSocket authorization.

## Alternatives

- Continue relying only on tailnet membership.
- Use an external identity SaaS.
- Store local accounts and revocable sessions in SQLite.

## Decision

Store accounts, opaque hashed sessions, invitations, stable board IDs, and owner/editor/viewer memberships in a central `auth.sqlite`. Use a same-origin `HttpOnly; SameSite=Strict` cookie for browsers and keep existing bearer tokens as separate machine principals. Enforce membership before opening room state and pass viewer status into tldraw's server-side read-only controls.

## Consequences

The installation remains self-contained and sessions can be revoked immediately. The first user must bootstrap the installation, and collaborators need invitations. HTTP remains suitable only inside Tailscale; HTTPS is required before public exposure.
