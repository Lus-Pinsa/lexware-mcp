# ADR: Audit append order and prefix-only retention (schema v7)

Status: **IMPLEMENTED on branch `claude/pg-harness-privileges`, review pending — not approved, not merged, not deployed.**
Supersedes the draft `ai-company/persistence/audit-order-v6-adr.md` from branch `openai/audit-append-order-v6-adr`
(commit `c16986e`, never merged). That draft's analysis and acceptance table are taken over here; the numbering
changes to v7 because migration 006 is already used by PR #34.

## Problem (reproduced on real PostgreSQL)

Up to schema v6 the chain head was selected with `ORDER BY created_at DESC, audit_id DESC`, verification and retention
used `ORDER BY created_at, audit_id`, and retention deleted `created_at < cutoff`. Chain order therefore followed the
caller-supplied event time and the random UUID, not the append order. On real PostgreSQL
(`tests/persistence-pg-audit-order.test.ts`, run against the v6 code) all of the following failed:

- two appends in the same millisecond with inverted UUID order → chain unverifiable
- a third append in that millisecond → **fork** (two entries with the same predecessor)
- a backdated event → chain unverifiable
- 12 concurrent appends from separate connections (tenant lock held) → chain unverifiable
- retention on such chains → blocked; prefix semantics not guaranteed

## Decision

1. **Append ordinal.** Each audit event gets `chain_seq bigint NOT NULL`: 1-based and gap-free per tenant.
   - It is allocated as head + 1 (or retention anchor + 1) under the existing transaction-scoped tenant advisory lock
     (PR #31). Head read, allocation and insert run in one transaction.
   - Event time (`created_at`) stays data and may repeat or run backwards.
2. **Database guards.**
   - `UNIQUE (tenant_id, chain_seq)`: no two entries at one position.
   - `UNIQUE (tenant_id, previous_hash) NULLS NOT DISTINCT`: no fork and no second root. This holds even for a writer
     that bypasses the application or the lock; such a writer fails instead of corrupting the chain.
   - Requires PostgreSQL ≥ 15.
3. **Hash format v2.**
   - The canonical JSON hashed per entry is `{v: 2, chainSeq, auditId, tenantId, actorHash, action, result, itemCount,
     createdAt, previousHash}`.
   - The column `chain_version smallint CHECK (= 2)` records the format explicitly.
   - Moving an entry to another position therefore breaks its hash.
4. **Verification** reads by `chain_seq ASC` with the existing limit + 1 sentinel (PR #28). Every entry must satisfy:
   - its position is exactly the next one (first: anchor position + 1, or 1)
   - its chain version is 2
   - `previous_hash` equals the predecessor's hash (first: the anchor hash, or NULL)
   - its recomputed hash matches

   A gap, duplicate, reordering, wrong anchor position or unknown version fails closed. A chain beyond the window is
   reported as "exceeds the integrity verification limit", never as verified.
5. **Retention** runs in one tenant-locked transaction:
   - verify the complete chain
   - take the longest prefix in append order whose entries are all older than the cutoff, stopping at the first newer
     entry even if later entries are older
   - move the anchor to the last pruned entry (`previous_hash`, `last_pruned_seq`)
   - delete exactly `chain_seq <= last_pruned_seq`, with the deleted row count checked against the verified prefix
   - verify the remaining chain
   - append the `retention.run` record (capacity check included)

   Any failure rolls back everything. A bare `DELETE … created_at < cutoff` on the chain no longer exists.
6. **Legacy history.** Rows from v1–v6 have no authoritative ordinal, and their order cannot be reconstructed from time
   or UUID without guessing.
   - Persistence has never been enabled in production, so migration 007 adds the new columns as `NOT NULL` without a
     default.
   - With any existing audit row or retention anchor the migration fails and rolls back atomically, without changing
     data (`tests/persistence-pg-audit-guards.test.ts`).
   - Remediation for such a database is a separate owner decision. Options: validated unique predecessor graph,
     quarantined legacy segment, or a new anchored epoch.
7. **Restore digest** orders audit rows by `chain_seq`. Entry hashes cover the position.

## Evidence (synthetic data, ephemeral PostgreSQL 16, TLS, real driver)

| Scenario | Test | Result |
|---|---|---|
| Same millisecond, inverted UUIDs | `persistence-pg-audit-order` | verifies |
| No fork on third same-ms append | `persistence-pg-audit-order` | unique predecessors |
| Backdated event | `persistence-pg-audit-order` | verifies |
| 12 concurrent appends, one tenant, separate connections | `persistence-pg-audit-order` | one linear chain |
| Concurrent appends, two tenants | `persistence-pg-audit-order` | isolated, both verify |
| Retention prefix stops at first retained entry | `persistence-pg-audit-order` | nothing pruned |
| Retention prunes prefix, keeps later backdated entry | `persistence-pg-audit-order` | 2 pruned, rest verifies |
| Direct INSERT at occupied position / fork / second root | `persistence-pg-audit-guards` | rejected by the database |
| v6 → v7 with legacy row | `persistence-pg-audit-guards` | fails, ledger v6, data unchanged |
| v6 → v7 on empty history | `persistence-pg-audit-guards` | succeeds |
| Capacity full, nothing expired | `persistence-pg-audit-guards` | retention fails, complete rollback |
| Capacity full, expired prefix exists | `persistence-pg-audit-guards` | prunes, own record fits |
| 100 000 entries / 100 001 entries | `persistence-pg-audit-guards` | verified / refused |
| Gap, duplicate, wrong anchor position, version, moved entry | `persistence-integrity` (unit) | fail closed |
| Delete count mismatch, out-of-order rows, empty chain | `persistence-maintenance` (unit) | fail closed / no mutation |

## Open (not decided here)

- Treatment of a database that already holds legacy audit history (see 6).
- The 100 000-entry window is a bounded V1 verifier, not proof of scalable verification. Incremental or checkpointed
  verification is future work.
- Independent review of this design and code (creator ≠ reviewer). Release evidence on the final integrated SHA in CI.
