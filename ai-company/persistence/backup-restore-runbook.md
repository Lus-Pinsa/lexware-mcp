# Persistence Backup & Restore Runbook

Status: **IMPLEMENTATION READY · LIVE RESTORE DRILL PENDING**  
Last reviewed: 2026-10-09

This runbook implements the operational side of P-60/P-61/P-62 without turning the LU'S MCP service into a legal archive. Lexware remains the source of truth.

## 1. Backup policy

### Automated baseline

Production durable storage uses paid managed PostgreSQL on Render.

- Provider-managed point-in-time recovery (PITR) is the automated baseline.
- The database and provider-managed backups remain encrypted at rest by the platform.
- The application AES-256-GCM keyring is **not** the backup-encryption mechanism and is never copied into backup artifacts.
- Recovery-window length is plan-dependent. The operator must verify the current Render recovery window before go-live and after any workspace/plan change.
- A production plan change that removes the accepted recovery capability blocks persistence go-live until this runbook is updated.

### Before destructive migrations

Destructive schema changes remain Owner-gated and are not part of the normal migration runner.

Before any approved destructive migration:

1. Create a fresh logical backup/export or a provider recovery point.
2. Record the backup timestamp and source commit outside the public repository.
3. Restore it into an isolated database.
4. Run the restore verifier in this runbook.
5. Do **not** execute the destructive migration until the verifier passes.

A backup is not reported as **VERIFIED** merely because Render says a backup/recovery point exists.

## 2. Separation rules

- Never restore directly over the production database.
- The restore target starts isolated from the application.
- The restore target must not receive Lexware, OAuth, MCP or application secrets it does not need.
- Database URLs and passwords stay in the operator shell / Render secret store and never appear in GitHub, PRs, logs or screenshots.
- The application persistence encryption keyring remains in the secret store. It is required to use encrypted persisted identifiers after recovery, but it is not stored in the database backup.
- Restore verification reads only tenant identifiers, already-hashed checksums, timestamps and audit-chain hashes. It does not decrypt voucher/resource identifiers.

## 3. Restore drill

### Preconditions

- Source and restore database are separate instances.
- Restore target was created from the backup/recovery point being tested.
- The exact application commit under test is known.
- LUS_TENANT_ID is supplied from the secure runtime configuration.
- The chosen TLS mode matches the approved deployment path.

### Verification command

Run from a trusted environment that can reach **both** database endpoints:

    PERSISTENCE_SOURCE_DATABASE_URL=... \
    PERSISTENCE_RESTORE_DATABASE_URL=... \
    LUS_TENANT_ID=... \
    PERSISTENCE_TLS_MODE=verify-full \
    npm run persistence:verify-restore

For an approved Render-private path whose certificate model requires the documented exception, use the separately reviewed require mode. Do not weaken the public/external connection policy.

The command intentionally never prints either database URL or any database contents.

## 4. PASS criteria

The verifier fails closed unless source and restore match on:

- complete migration ledger count + SHA-256 digest,
- explicit tenant row presence and hashed organization binding,
- durable webhook-event count + SHA-256 digest over safe hashes/timestamps,
- audit-event count + SHA-256 digest over audit IDs/entry hashes,
- audit-retention anchor,
- recomputed append-only audit hash-chain head,
- tenant identity.

It also independently recomputes the retained audit hash chain and rejects cross-tenant rows.

A PASS is valid only for the exact source/restore pair and timestamp tested.

## 5. Failure handling

If verification fails:

1. Keep the restore isolated.
2. Do not point the application at it.
3. Record only the mismatch field names / fixed error class — never row contents.
4. Try another recovery point only after the failure is understood.
5. If no recovery point verifies, persistence remains **UNAVAILABLE**, not empty.
6. Lexware remains the operational source of truth.

## 6. Evidence record

For every drill record, outside this public repository:

- date/time,
- source application commit,
- backup/recovery timestamp,
- restore target identifier,
- verifier result,
- schema migration count,
- webhook row count,
- audit row count,
- operator identity reference.

Do not record database URLs, passwords, encryption keys, resource IDs, voucher content or personal data.

## 7. Go-live gate

P-62 remains **PENDING LIVE EVIDENCE** until at least one isolated restore has passed the verifier.

Production persistence may be code-complete before that drill, but the backup control must not be labeled VERIFIED until the drill evidence exists.
