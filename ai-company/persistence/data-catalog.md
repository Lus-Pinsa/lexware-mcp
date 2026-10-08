# Persistence data catalog

Status: proposed, satisfies design requirement P-01 before schema implementation.

| Field group | Purpose | Class | Proposed representation | Proposed retention |
|---|---|---|---|---|
| `tenant_id` | immutable internal tenant key | INTERNAL | UUID | tenant lifetime |
| Lexware organization binding | resolve webhook/source to tenant | FINANCIAL | SHA-256 digest only | tenant lifetime |
| webhook event key | idempotency/deduplication | FINANCIAL | SHA-256 digest | 30 days after acknowledgement |
| webhook resource id | fetch changed voucher later | FINANCIAL | AES-256-GCM ciphertext + nonce + auth tag + key id | 30 days after acknowledgement |
| event type | routing | INTERNAL | constrained enum | 30 days after acknowledgement |
| receive/ack timestamps | queue ordering and operations | INTERNAL | timestamptz | 30 days after acknowledgement |
| webhook provenance/quality | prove source/freshness/data quality | INTERNAL | constrained source + request-budget + quality enums | 30 days after acknowledgement |
| payload checksum | corruption/dedup evidence | FINANCIAL | SHA-256 digest | 30 days after acknowledgement |
| audit actor | accountability | PERSONAL DATA | salted one-way hash | 1 year |
| audit action/result/count | security trail | INTERNAL | structured columns only | 1 year |
| audit chain hashes | tamper evidence | INTERNAL | SHA-256 | 1 year |
| migration version/checksum | schema safety | INTERNAL | integer + hash | indefinitely |

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
