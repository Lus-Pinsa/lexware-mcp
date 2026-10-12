# ADR: Audit append order and prefix-only retention (schema v7)

Status: **IMPLEMENTED — schema v7 on branch `claude/audit-append-ordinal` (commit `b41ab5f`, reviewed), database append
guard v8 and v9 on branch `claude/pg-runtime-gates` (fix rounds 1 and 2, review of round 2 pending). Not approved, not
merged, not deployed.**
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
   - `UNIQUE (tenant_id, chain_seq)` (v7): no two entries at one position.
   - `UNIQUE (tenant_id, previous_hash) NULLS NOT DISTINCT` (v7): no fork, and no second root while the original root
     still exists. Requires PostgreSQL ≥ 15.
   - The unique indexes alone do **not** stop a writer that bypasses the application from inserting at a gap
     (`head + 10`) or a new root after the original root was pruned (independent security review, finding L1). Either
     would leave the chain permanently unverifiable. Therefore migration 008 adds an owner-owned `BEFORE INSERT`
     trigger (`audit_events_append_guard`): an event is accepted only at exactly `head + 1` (or anchor position + 1)
     with `previous_hash` equal to the head hash (or the anchor hash). The runtime role holds no TRIGGER privilege
     (checked at start-up). Migration 008 also asserts that both v7 indexes exist exactly as designed (v7 used
     `IF NOT EXISTS`, finding L3).
   - Not prevented by the database: a writer with INSERT that computes a correct hash for `head + 1`. The hash is not
     keyed; the runtime role's INSERT right is the trust boundary.
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

8. **Session hardening (fix round 1).** The production driver sends `search_path=public, pg_temp`, `TimeZone=UTC` and
   `default_transaction_isolation=read committed` at connect time; these override role or database defaults. Audit
   timestamps are accepted only within 1970–9999 UTC, because PostgreSQL prints years below 1000 and historic offsets in
   forms the driver parses as a different instant (finding M1). The runtime privilege check also rejects CREATE on any
   schema, owning a schema, REPLICATION and REFERENCES (finding M2, F5).

9. **Start-up and restore verify the safety objects (fix round 2).** The ledger proves which scripts ran, not that their
   effects are intact. Therefore:
   - Migration 009 sets the append guard to `ENABLE ALWAYS`, so it also fires under
     `session_replication_role = replica`.
   - Start-up (`src/server.ts`) and both sides of a restore check:
     - forced row-level security on all four tenant tables;
     - exactly the four expected policies (an extra permissive policy or `USING (true)` fails);
     - the guard trigger: enabled ALWAYS, its function owned by the table owner, not SECURITY DEFINER;
     - both guard indexes.
   - The runtime role check rejects any parameter privilege (`pg_parameter_acl`), ownership of any object, and default
     privileges granted to it.
   - Pinned session settings now also cover `DateStyle`, `IntervalStyle`, `bytea_output` and `extra_float_digits`.
     Start-up asserts that all of them are in effect (a pooler may drop startup parameters).
   - Query parameters in the database URL other than the stripped SSL hints are rejected, because they would override
     the pinned settings.
   - The restore manifest (version 2) also covers:
     - tenant storage limits and creation time;
     - every stored webhook column, including the encrypted resource;
     - the anchor position.
10. **Restore procedure.** Only a full logical restore (`pg_dump` → `pg_restore` into an empty database) is supported.
    A data-only restore into a migrated schema fails closed: COPY fires the guard, and the heap order is not the chain
    order.

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
| Direct INSERT at occupied position / fork / second root / gap / wrong link | `persistence-pg-audit-guards` | rejected by the guard trigger (SQLSTATE 23514) |
| Same, with the trigger disabled by a superuser | `persistence-pg-audit-guards` | rejected by the unique indexes (23505, constraint named) |
| New root after the original root was pruned | `persistence-pg-audit-guards` | rejected (23514) |
| Guard index pre-empted by a same-named relation | `persistence-pg-audit-guards` | migration 008 fails, ledger stays v7 |
| Role defaults TimeZone / isolation / search_path changed | `persistence-pg-audit-guards` | overridden; 8 concurrent appends all succeed |
| v6 installation with a tenant, no audit history → v9 | `persistence-pg-audit-guards` | upgrades; chain starts at position 1 |
| Runtime granted SET on `session_replication_role`, gap insert in replica mode | `persistence-pg-audit-guards` | rejected (23514, guard ALWAYS); start-up rejects the role (PARAMETER_PRIVILEGE) |
| Guard dropped/disabled/not ALWAYS/SECURITY DEFINER, RLS off, extra or replaced policy, index dropped or weakened | `persistence-pg-runtime-startup` | start-up refused with a fixed code |
| Role defaults DateStyle/bytea_output/IntervalStyle; startup parameter dropped by a proxy | `persistence-pg-runtime-startup` | overridden / start-up refused |
| Restore with raised limits, moved event date, zeroed auth tag, changed status, dropped guard, RLS off, open policy, dropped indexes, moved anchor | `persistence-pg-restore` | detected |
| v6 → v7 with legacy row | `persistence-pg-audit-guards` | fails, ledger v6, data unchanged |
| fresh database v0 → v8 | `persistence-pg-audit-guards` | succeeds, empty chain verifies |
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
- **Owner decision (security review round 2, F5):** A role with INSERT can append an entry at the correct position
  and with the correct link but a bogus hash. The guard checks position and link, not the hash, so the chain is then
  permanently unverifiable and retention is blocked; detection works. Anyone with runtime credentials can also forge
  entries that verify, because the hash is unkeyed SHA-256 over stored fields. Options:
  - recompute the hash in the trigger;
  - a keyed HMAC with the key outside the database;
  - switch to read-only after a failed verification.
- Residuals from the independent reviews (accepted for now, documented):
  - A superuser or the table owner can disable the guard trigger; the runtime role cannot. Start-up now refuses to run
    when the trigger is not enabled ALWAYS.
  - Managed PostgreSQL offerings (predefined roles, provider schemas granting CREATE to PUBLIC) may make the stricter
    role check fail closed; only PostgreSQL 16 was tested.
  - `MAINTAIN` (PostgreSQL 17+) is not in the forbidden privilege set; PostgreSQL 16 rejects the keyword. Add it before
    moving to PostgreSQL 17.
  - The runtime role keeps the default TEMPORARY privilege; with `pg_temp` last in `search_path` a temporary table
    cannot shadow a persistence table (tested).
  - A chain above 100 000 entries (reachable only by bypassing the application) can never be pruned, because retention
    needs a full verification. That needs an operator remediation path.
  - `applyPendingMigrations` reports a version error as a generic transaction failure (pre-existing).
