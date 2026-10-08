# Render internal PostgreSQL TLS decision

Status: **OWNER DECISION REQUIRED BEFORE PRODUCTION ENABLEMENT**  
Date: 2026-10-08  
Scope: P-20 / P-24 of the Persistence Security Contract.

## Platform fact

Render documents that internal PostgreSQL connections use self-signed certificates and therefore **do not support** `sslmode=verify-ca` or `sslmode=verify-full`. Render's documented encrypted-only setting for an internal connection is `sslmode=require`.

Source checked 2026-10-08:
https://render.com/docs/postgresql-creating-connecting#ssl-modes-for-internal-connections

The LU'S Postgres instance currently has external access disabled by an empty IP allowlist. The web service and database are in the same Render region, so the internal connection stays on Render's private network.

## Conflict with the current contract

P-20 currently says TLS must use `verify-full` (or an equivalent mode with certificate verification). Render's private internal endpoint cannot satisfy certificate verification as written.

P-24 separately requires network isolation. The current empty external allowlist satisfies the stronger network-isolation direction and should not be weakened merely to make `verify-full` possible.

## Options

### A — Private internal network + `require` (recommended)

- keep external DB access disabled;
- connect only over Render's private internal network;
- require TLS encryption; no plaintext fallback;
- accept that Render's self-signed internal certificate is not CA/hostname verified;
- record an explicit Owner-approved exception to P-20.

Risk: a successful active network impersonation inside the trusted Render private network would not be detected by certificate identity verification.

### B — External endpoint + `verify-full`

- requires a safely restricted public-network path;
- do **not** open the DB to `0.0.0.0/0`;
- requires stable service egress / allowlisting (and potentially additional platform cost);
- higher operational complexity and public attack surface.

## Code policy

- default remains `verify-full`;
- `require` must be explicitly configured with `PERSISTENCE_TLS_MODE=require`;
- `disable`, `allow`, and `prefer` are rejected;
- persistence remains disabled until the Owner decision and deployment gates are complete.

No production setting is changed by this document.
