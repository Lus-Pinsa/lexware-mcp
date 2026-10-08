# Persistence acceptance matrix

Status: proposed test plan. No persistence code exists yet.

## Contract coverage

| Contract | Minimum acceptance evidence |
|---|---|
| P-01 | this data catalog exists before schema code |
| P-02 | `PRODUCTION_WRITE_TOOLS` unchanged; no new Lexware write call |
| P-03 / T-01 | every tenant-owned table has `tenant_id NOT NULL` |
| P-10/P-11/P-12 | structural tests forbid blobs/full text/contact PII/secrets |
| P-20/P-24 | DB connection requires TLS verification; no plaintext fallback |
| P-21/P-22 | AES-256-GCM round-trip, unique nonce, wrong AAD fails, key rotation |
| P-30/P-31 | migration/runtime roles separated; audit UPDATE/DELETE denied |
| P-33 | application queries parameterized; no dynamic SQL outside migration package |
| P-40/P-41 | versioned transactional migrations; unknown/newer version fails closed |
| P-42/P-43 | constraints + source/freshness/quality metadata |
| P-50 | failed logical write rolls back atomically |
| P-51 | duplicate webhook replay creates one row |
| P-52 | integrity failure makes persistence unavailable, not auto-repaired |
| P-53/P-54 | kill/restart tests show consistency; unavailable != empty |
| P-55 | per-tenant count/size limits are explicit and fail visibly |
| P-60/P-61/P-62 | backup process + restore runbook + verified restore |
| P-70/P-71/P-72 | retention job + tenant deletion |
| P-80/P-81/P-82 | append-only audit, no PII/content, hash chain |
| P-90/P-91/P-92 | untrusted output, freshness labels, central redaction |
| T-02 | static test forbids direct DB access outside repository layer |
| T-04/T-06 | missing/invalid tenant context fails closed |
| T-08 | unknown organization webhook never persists |
| T-09 | queue bounds isolated per tenant |
| T-11 | horizontal escalation matrix blocks tenant A from tenant B |
| T-12 | PostgreSQL RLS blocks direct cross-tenant reads as second line |
| T-13 | one tenant's capability config cannot enable another tenant's writes |

## Adversarial cases

- tenant A supplies tenant B identifiers
- tenant A ciphertext copied into tenant B row; AAD verification must fail
- validly signed webhook with unknown organization
- duplicate/replayed webhook
- SQL-injection payloads in external identifiers
- DB disconnect during transaction
- process kill before commit
- corrupt/missing encryption key
- old/unknown key id
- database schema newer than application
- runtime role attempts DDL
- runtime role attempts audit UPDATE/DELETE
- RLS tenant setting missing
- storage unavailable at startup

## Gate

Implementation remains BLOCKED until P-00 owner approval. No test result may be marked green before executable evidence exists.
