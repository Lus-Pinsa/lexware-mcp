# ADR (DRAFT): Audit append order and safe retention

Status: **PROPOSED — NOT IMPLEMENTED / NOT APPROVED**. Scope: design and test gates only. This document is based on the persistence stack at `openai/persistence-capacity-test-fixtures`; revalidate against the eventual integration SHA. No production migration or release is authorized.

## Observed behavior and failure mode

- `src/persistence/repository.ts` selects the latest audit hash with `ORDER BY created_at DESC, audit_id DESC LIMIT 1` before appending.
- `src/persistence/maintenance-repository.ts` selects a retention anchor with the same timestamp/UUID ordering and deletes all rows where `created_at < cutoff`.
- `src/persistence/migrations/001_foundation.sql` defines `created_at timestamptz`, a UUID primary key and an index `(tenant_id, created_at, audit_id)`, but no immutable append ordinal.
- `src/persistence/migrations/003_audit_retention_anchor.sql` stores only `previous_hash` and `updated_at` per tenant.
- The chain is therefore linked by **selected event time**, not necessarily by **commit/append order**. Two entries with equal timestamps can sort by unrelated UUIDs. Backdated timestamps can make retention delete an interior chain link. Both can make a valid append history unverifiable. This is a design risk; reproduction against real PostgreSQL is still required.

## Proposed invariant

For each tenant, committed audit events have a unique, immutable, strictly increasing **tenant-local append ordinal**. The predecessor of ordinal `n` is the committed event at ordinal `n-1`, or the validated retention anchor at the start of the retained suffix. Neither user-provided event time nor UUID determines chain order. Every successful retention operation removes **only a verified contiguous prefix** and atomically advances the anchor to that prefix's final hash and ordinal. If verification or any precondition fails, the transaction rolls back without deletion.

## Candidate design for independent review

1. Add an append ordinal (`bigint`, NOT NULL, unique per tenant) and an explicit chain version, with a tenant-scoped allocator protected by a transaction-scoped lock. A PostgreSQL global sequence alone is **not** sufficient for contiguous tenant ordinals or commit-order guarantees. Choose a transactional tenant-head counter or another proven design. Check overflow, aborted transactions, and concurrent transactions.
2. In one tenant-bound transaction: acquire the same tenant lock for **all** append and maintenance callers; read and validate the head; allocate the next ordinal; hash canonical fields including the ordinal and chain version; insert the row; commit. Do not silently reinterpret v1 hashes as v2.
3. Verify chains by `tenant_id, append_ordinal ASC` with strict gap, duplicate, hash and predecessor checks. Compare the first retained event to the stored anchor; reject malformed or missing anchors. A bounded verifier must report **incomplete**, never “valid”.
4. Retention: after locking and verifying the complete relevant chain, identify the largest **contiguous prefix in append order** whose rows satisfy the time-based policy. Stop at the first ineligible row, even if later rows are older. Within the same transaction, advance the anchor (hash **and** ordinal), delete exactly that prefix by tenant and ordinal, append a retention audit record, then verify the remaining suffix. Roll back on any mismatch. Never use a bare `DELETE WHERE created_at < cutoff` on the audit chain.
5. Preserve least privilege: application runtime may append and verify, but must not UPDATE/DELETE audit rows or mutate retention anchors. Retention uses an explicitly separated maintenance identity and a reviewed transaction boundary. PostgreSQL RLS must be enforced for both reads and writes; maintenance bypasses, if any, require explicit audit and approval.
6. Migration is a **separate, owner-approved design decision**. Existing rows have no authoritative append ordinal. Timestamp/UUID order cannot be assumed to reconstruct original history. Options include a cryptographically validated unique predecessor graph (reject ambiguous/corrupt chains), a quarantined legacy segment, or a new anchored epoch with documented evidence. Never backfill by timestamp alone or rewrite historic hashes silently.

## Required adversarial PostgreSQL acceptance tests (ephemeral DB, synthetic data)

| Scenario | Required result |
| --- | --- |
| Two appends with identical event timestamps and inverted UUID lexical order | Ordinals reflect serialized append order; full chain verifies |
| A later append with an older event timestamp | No predecessor corruption; retention stops at first ineligible ordinal |
| Two concurrent writers to the same tenant (separate connections) | No duplicate ordinals or divergent heads; transaction lock released on rollback |
| Parallel writers to distinct tenants | Isolation preserved; no cross-tenant data or hashes |
| Failure after anchor update but before delete, and vice versa | Atomic rollback; original chain and anchor intact |
| Prefix eligible, interior row ineligible, later row eligible | Only eligible **prefix** pruned; later eligible row retained |
| Tampered hash, missing ordinal, gap, duplicate or incorrect anchor | Fail closed, no retention deletion |
| Partial/limited verification | Report incomplete; no destructive maintenance |
| Runtime role attempts anchor mutation, audit UPDATE/DELETE or tenant crossover | Permission/RLS denial |
| Legacy noncanonical timestamp hashes and legacy v1 rows | Explicit compatibility gate, no silent rewrite |
| Restart, repeated retention, leap-day cutoff and transaction retry | Deterministic and idempotent outcome with complete evidence |

## Release evidence and dependencies

- Resolve the overlap between PR #30 (timestamp canonicalization) and PR #31 (tenant advisory lock); independently review any test expecting `FOR UPDATE`.
- PR #28 (truncated-chain fail-closed) must be reflected in the integrated verifier.
- Evidence must include schema and migration review, real PostgreSQL integration logs, least-privilege role tests, concurrency tests, complete CI/CodeQL at the **final integrated SHA**, independent security review, rollback/restore exercise, and explicit owner approval for merge/deploy.
- Do not infer integration success from green CI on isolated stacked PRs. This ADR does not authorize merging, production configuration, secrets, database provisioning, costs or Lexware writes.

## Open decisions

1. Transactional ordinal allocator and lock namespace (including interaction with PR #31).
2. Versioned hash format and anchor schema (ordinal, hash, chain version).
3. Treatment of unverifiable or ambiguous legacy history.
4. Retention policy when an older event appears after a newer ineligible event (preserve chain continuity rather than delete out of order).
5. Operator recovery procedure for a corrupt chain, with human approval and tamper-evident evidence.
