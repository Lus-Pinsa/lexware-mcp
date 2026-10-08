# Persistence data catalog

Status: approved design input. P-00 was approved by Luigi on 2026-10-08; this catalog satisfies P-01 before schema implementation.

| Field group | Purpose | Class | Source | Proposed representation | Retention | Deletion path |
|---|---|---|---|---|---|---|
| `tenant_id` | immutable internal tenant key | INTERNAL | owner-controlled bootstrap | UUID | tenant lifetime | tenant deletion (P-72) |
| Lexware organization binding | bind the explicitly configured tenant to one Lexware organization | FINANCIAL | `LEXWARE_ORGANIZATION_ID` at bootstrap / startup verification | SHA-256 digest only | tenant lifetime | tenant deletion (P-72) |
| webhook event key | idempotency/deduplication | FINANCIAL | derived from verified webhook metadata | SHA-256 digest | 30 days after acknowledgement | retention job (P-71) or tenant deletion |
| webhook resource id | fetch changed voucher later | FINANCIAL | verified Lexware webhook | AES-256-GCM ciphertext + nonce + auth tag + key id | 30 days after acknowledgement | retention job (P-71) or tenant deletion |
| event type | routing | INTERNAL | verified Lexware webhook | constrained enum | 30 days after acknowledgement | retention job (P-71) or tenant deletion |
| receive/ack timestamps | queue ordering and operations | INTERNAL | server clock / acknowledgement action | timestamptz | 30 days after acknowledgement | retention job (P-71) or tenant deletion |
| webhook provenance/quality | prove source/freshness/data quality | INTERNAL | server/finance quality layer | constrained source + request-budget + quality enums | 30 days after acknowledgement | retention job (P-71) or tenant deletion |
| payload checksum | corruption/dedup evidence | FINANCIAL | SHA-256 over exact verified webhook bytes | SHA-256 digest | 30 days after acknowledgement | retention job (P-71) or tenant deletion |
| audit actor | accountability | PERSONAL DATA | authenticated principal or fixed system actor; never email | salted/HMAC one-way hash | 1 year | retention job / tenant deletion subject to incident/legal hold |
| audit action/result/count | security trail | INTERNAL | persistence/security operations | structured columns only | 1 year | retention job / tenant deletion subject to incident/legal hold |
| audit chain hashes | tamper evidence | INTERNAL | derived from preceding audit entry | SHA-256 | 1 year | follows audit event deletion |
| migration version/checksum | schema safety | INTERNAL | repository migration manifest | integer + SHA-256 | indefinitely | only through approved schema lifecycle |

## Explicitly excluded from v1 persistence

- PDFs or file blobs
- extracted PDF full text
- contact names, email addresses, phone numbers, postal addresses
- IBAN or payment-instrument data
- raw finance snapshots / whole vouchers
- API keys
- MCP bearer tokens
- OAuth access/refresh tokens
- encryption keys
- environment secrets
- arbitrary untrusted document text

Lexware remains the source of truth and legal archive.
