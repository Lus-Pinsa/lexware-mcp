# Persistence acceptance matrix

Status: **IMPLEMENTATION IN PROGRESS — evidence tracked, no green-by-assumption**  
Updated: 2026-10-09

Legend:
- **IMPLEMENTED** — executable code + deterministic tests exist on the canonical persistence stack.
- **PARTIAL** — meaningful control exists, but one contract element or live proof is still open.
- **PENDING LIVE** — code/runbook exists, but production-like operational evidence is still required.

## Contract coverage

| Contract | Status | Current evidence / remaining gate |
|---|---|---|
| P-01 | IMPLEMENTED | data-catalog.md exists before production schema rollout |
| P-02 | IMPLEMENTED | persistence code has no Lexware write client path; finance/governance policy remains green |
| P-03 / T-01 | IMPLEMENTED | tenant_id is mandatory from migration 001; FORCE RLS on tenant-owned tables |
| P-10/P-11/P-12 | IMPLEMENTED | schema/structural tests exclude PDFs, full text, contact PII, banking data and secrets |
| P-20 | IMPLEMENTED | PostgreSQL driver has explicit TLS modes and strips URL-level SSL overrides |
| P-24 | PARTIAL | production database network isolation is an environment control; live evidence is checked separately from this public repository |
| P-21/P-22 | IMPLEMENTED | AES-256-GCM + AAD + random nonce + key-id keyring; missing/wrong keys fail closed |
| P-30/P-31 | PARTIAL | runtime privilege inspection/gate is implemented; production role provisioning still needs live verification |
| P-33 | IMPLEMENTED | static structural policy restricts direct queries to reviewed repository/migration adapters; external values are parameterized |
| P-40/P-41 | IMPLEMENTED | checksummed forward-only migrations, serialized transactional application, future/checksum drift fails closed |
| P-42/P-43 | IMPLEMENTED | DB constraints plus provenance, request-budget and quality fields |
| P-50 | IMPLEMENTED | logical repository/migration operations use database transactions |
| P-51 | IMPLEMENTED | tenant+event hash primary key and ON CONFLICT idempotency |
| P-52 | PARTIAL | migration checksum + retained audit-chain integrity fail closed; provider/native physical corruption evidence remains operational |
| P-53/P-54 | PARTIAL | durable PostgreSQL queue replaces RAM when enabled; explicit kill/redeploy live drill remains open |
| P-55 | IMPLEMENTED | v1 snapshots are intentionally absent (max 0); persisted per-tenant webhook/audit row ceilings and 64 MiB tenant byte ceiling fail visibly inside tenant transactions |
| P-60 | PARTIAL | managed PITR baseline + backup policy documented; live provider recovery settings/key-separation evidence must be retained operationally |
| P-61 | IMPLEMENTED | backup-restore-runbook.md + incident-response recovery path |
| P-62 | PENDING LIVE | source-vs-restored verifier checks migrations, tenant binding, row counts, SHA-256 evidence and audit chain; isolated restore drill still required |
| P-70 | IMPLEMENTED | 30-day acknowledged webhook retention and one-calendar-year audit retention encoded |
| P-71 | PARTIAL | atomic auditable retention runner exists; automatic production execution path is not enabled yet |
| P-72 | PARTIAL | exact tenant deletion repository + FK cascade is tested; production operator path/live deletion drill remains gated |
| P-80/P-81/P-82 | IMPLEMENTED | append-only structured audit + no content/PII + chained hashes + retention anchor |
| P-90/P-91/P-92 | PARTIAL | central safe redaction and timestamps exist; all future persistence-backed user outputs must preserve freshness/untrusted labeling |
| T-02 | IMPLEMENTED | tenantId is mandatory in tenant repositories; static DB-access policy enforced |
| T-04/T-06 | IMPLEMENTED | explicit LUS_TENANT_ID + organization binding; missing/mismatch fails closed |
| T-08 | IMPLEMENTED | verified webhook organization is bound before durable enqueue |
| T-09 | IMPLEMENTED | durable queue keys and queries are tenant-bound with per-tenant capacity |
| T-11 | PARTIAL | cross-tenant rows/AAD/tenant IDs have adversarial tests; full multi-principal matrix follows auth membership implementation |
| T-12 | IMPLEMENTED | PostgreSQL FORCE RLS with transaction-scoped app.tenant_id |
| T-13 | IMPLEMENTED | persisted per-tenant capability ceiling defaults read-only and startup fails if effective writes exceed that tenant's policy |

## Adversarial cases

Covered in executable tests:
- tenant A / tenant B row mismatch rejection,
- ciphertext copied across tenant/AAD context,
- duplicate webhook replay,
- parameterization / no identifier interpolation,
- missing/corrupt encryption key,
- unknown/newer migration state and checksum drift,
- runtime privilege escalation facts,
- RLS tenant context setup,
- tampered/broken audit hash chain,
- malformed retention cutoffs,
- restored database checksum/count mismatch.

Still requiring operational evidence:
- process kill during real PostgreSQL transaction,
- Render restart/redeploy durability,
- isolated backup restore,
- production runtime-role grants,
- production retention scheduling.

## Gate

**P-00 owner approval was given on 2026-10-08 for managed PostgreSQL.**

Code completion does not equal production readiness. Destructive migrations, merge-to-main, production persistence enablement and restore verification remain independently gated.
