# ADR 004: Cloudflare Access and Tunnel for the public whiteboard

- Status: Accepted
- Date: 2026-09-15

## Context

The whiteboard runs as one Node/SQLite process on `your-server`, bound to
`127.0.0.1:8787`. People outside the Tailnet need a normal HTTPS address without
opening an inbound router port or mixing the application with the existing site.

## Decision

Publish `https://whiteboard.example.com` through this chain:

`Cloudflare Access → Cloudflare Tunnel → http://127.0.0.1:8787`

Create the deny-by-default Access application before publishing the Tunnel route.
Allow only explicitly approved identities. Enable Protect with Access for the
published route so `cloudflared` validates the Access token before forwarding.
The application retains its own accounts, invitations, and owner/editor/viewer
authorization. The service remains loopback-only and no router forwarding is used.

The dedicated subdomain is selected instead of `/whiteboard` because tldraw uses
root-relative SPA, API, asset, and WebSocket paths. A subdomain isolates those paths
and cookies from an unrelated application on the same base domain.

## Consequences

- Cloudflare supplies public DNS, TLS, the outer identity gate, and edge protection.
- App session cookies are `Secure` when the local proxy reports external HTTPS.
- Forwarded protocol and client-address headers are trusted only from loopback peers.
- The Tailscale Serve address remains a separate private rollback path and bypasses
  Cloudflare Access by design.
- An Access-approved person still needs a whiteboard account and board membership.
- Browser access and machine AI access require separate Access policy treatment;
  machine clients should remain Tailnet-only until a scoped service-token design is enabled.

## Rollback

Disable the public hostname route and stop `cloudflared`. Keep the Node service and
all SQLite data in place, retain the Tailscale origin in `CANVAS_ALLOWED_ORIGINS`,
and continue using `http://your-server`. No database rollback is required.
