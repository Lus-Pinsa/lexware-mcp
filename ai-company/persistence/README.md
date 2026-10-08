# Persistence Foundation — proposed architecture

Status: **DESIGN READY / P-00 OWNER APPROVED**  
Date: 2026-10-08

This package prepares Phase 2 persistence without implementing or provisioning storage yet.

## Owner decision

**P-00 approved by Luigi on 2026-10-08.**

Approved direction: **managed PostgreSQL** for durable production storage. This approval covers the architecture and the small paid durable-storage baseline when deployment reaches that step; it is not blanket authorization for future destructive migrations or unrelated paid services.

Why:
- transactions and crash consistency,
- separate migration/runtime roles,
- Row Level Security as a second tenant-isolation layer,
- managed backup/restore path,
- no SQLite-to-Postgres migration dead-end when a second tenant exists.

No database is provisioned by this design PR and no recurring cost is created by the documentation change itself.

## First implementation scope

The first implementation PR should persist only:

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
