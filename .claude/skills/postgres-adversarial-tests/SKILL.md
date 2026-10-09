---
name: postgres-adversarial-tests
description: Design and execute evidence-backed PostgreSQL persistence security and integrity tests for the LU'S AI Company. Use on SQL migrations, audit hash chains, retention, tenant isolation, RLS, transaction privileges, webhook durability and restore readiness.
---

# Real PostgreSQL: adversarial persistence acceptance

Before changing anything, read `AGENTS.md`, `SECURITY.md`, `ai-company/policies/` and `.claude/rules/ai-company-hard-rules.md`. **Use only an ephemeral disposable test database**. Never connect to Render production or any customer data source, never ask for or read real database credentials, and never run migrations against shared/prod instances.

## Verification hierarchy
1. **Static SQL review**: table definitions, indexes, constraints, tenant predicates, privileges, grants, RLS and migration compatibility.
2. **Unit + property-based/adversarial tests**: validate business invariants, malformed values and limits; mocks alone cannot prove PostgreSQL semantics.
3. **Ephemeral PostgreSQL integration**: pinned major-version test service/container, non-production synthetic fixtures, migrations applied transactionally, real driver and least-privilege roles. Record PostgreSQL version, migration hashes and exact commands.
4. **Crash/restore drills in isolated environment**: kill/restart during enqueue/acknowledge, verify exactly-once logical processing and encrypted data, idempotent retry, backup/restore manifest, read-only fail-closed startup.
5. **Independent review**: builder cannot certify own outcome; passing CI does not equal production release.

## Minimum attack/regression matrix
- Privilege checks: each required `SELECT`, `INSERT` and `UPDATE` removed *one at a time*; a missing privilege must fail. Forbidden mutation/DDL grants must also fail.
- Tenant isolation: two tenants, wrong tenant session var, missing tenant var, malicious explicit ID, concurrent connections/pool reuse and RLS enforcement.
- Audit chain: same millisecond, UUID reverse order, explicit backdating, mixed offsets, PostgreSQL microseconds, time zone/locale variations, invalid timestamp and corrupted intermediate hash.
- Retention: prefix-only deletion preserving anchor, holes, age-vs-append order, replay after deletion, repeated maintenance and concurrent append.
- Exhaustiveness: exactly at audit verification limit, limit+1, PostgreSQL returned count vs rows mismatch.
- Webhooks: duplicate delivery, malformed signature, payload replay, encrypted ID roundtrip, key rotation failure, service restart, queue backpressure and ack failure.
- Recovery: restore to disposable database; compare tenant counts/digests/integrity before and after. No claim of successful restore without execution evidence.
- Concurrency: concurrent append and dequeue across connections; verify locks, isolation level, rollback and no cross-tenant bleed.

## Execution standards
- Tests must be reproducible in GitHub CI and report the actual PostgreSQL version; do not rely on locally running Docker without documentation.
- Favor a dedicated workflow job with `services: postgres` and minimal token permissions, or an equivalent ephemeral runner. Never grant the job production secrets.
- Distinguish pass / fail / not run / blocked explicitly. Never downgrade/remove failed security assertions for a green badge.
- Do not alter current migration checksums or silently rehash retained audit events. Existing live data requires a separate reviewed migration and owner approval.

## Output
`MATRIX: case -> expected -> observed -> linked test/log`
`POSTGRES VERSION / SCHEMA VERSION / HEAD SHA`
`GAPS / SEVERITY / BLOCKERS / SAFE NEXT STEP`
`PRODUCTION READINESS: NOT VERIFIED unless separately approved with live drill evidence`
