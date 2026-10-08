# Persistence Foundation — proposed architecture

Status: **DESIGN READY / IMPLEMENTATION BLOCKED ON P-00**  
Date: 2026-10-08

This package prepares Phase 2 persistence without implementing or provisioning storage yet.

## Owner decision still required

Persistence contract P-00 requires Luigi to approve the paid durable-storage direction before implementation begins.

Recommended target: **managed PostgreSQL**.

Why:
- transactions and crash consistency,
- separate migration/runtime roles,
- Row Level Security as a second tenant-isolation layer,
- managed backup/restore path,
- no SQLite-to-Postgres migration dead-end when a second tenant exists.

No database is provisioned by this PR and no recurring cost is created.

## First implementation scope

After P-00 approval, the first code PR should persist only:

1. explicit tenants,
2. durable Lexware webhook events,
3. append-only security audit events,
4. schema version / migration state.

It must **not** persist PDFs, extracted PDF text, contact names/emails/addresses, banking data, raw finance snapshots, API keys, OAuth tokens, or other secrets.

## Security invariants

- No new Lexware write path.
- Every tenant-owned row has `tenant_id NOT NULL`.
- Every repository call requires tenant context.
- No implicit/default tenant.
- Unknown tenant or organization binding fails closed.
- Sensitive persisted identifiers use authenticated encryption.
- Runtime DB role has no DDL and no RLS bypass.
- Audit is append-only.
- Persistence unavailable is never reported as "empty".
- Backup is not considered valid until restore verification passes.

See:
- `data-catalog.md`
- `test-matrix.md`
- `../security/contracts/persistence-security-contract.md`
- `../security/contracts/multi-tenant-security-contract.md`
