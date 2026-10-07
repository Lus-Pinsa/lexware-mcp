# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Finance intelligence (Phase 2, PR 2)** — five READ-tier tools on pure, deterministic modules in `src/finance/`
  (no clock, no randomness, no LLM text; same input → byte-identical brief):
  - `analyze-voucher-duplicates`: rule table E1 (shared file SHA-256), E2/P1 (same counterparty + voucher number +
    amount, same day or not), S1–S3 (weaker combinations within a 14-day window) → EXACT/PROBABLE/POSSIBLE with reason
    codes and evidence; an equal amount alone never makes a duplicate; optional hash check for candidates only.
  - `get-open-items`: receivables/payables with OVERDUE_CONFIRMED only for a reliable due date (payment term or own due
    date), POSSIBLY_OVERDUE/DUE_DATE_UNRELIABLE otherwise, STATUS_UNKNOWN for unreviewed documents and contradictions,
    PAID_CONFIRMED only for status paid with open amount 0; credit notes keep an unknown direction.
  - `compare-finance-periods`: month to date vs. the same days of the previous month and the full previous month
    (reviewed gross expenses, Lexware invoice revenue — not POS revenue —, open amounts, unreviewed documents, top
    suppliers) with exact absolute/relative differences and the configurable anomaly rule (≥ 30 % and ≥ 250 €).
  - `get-finance-snapshot`: the normalized documents behind every statement, with data-quality findings.
  - `get-finance-daily-brief`: GRÜN/GELB/ROT with reasons, data quality, month to date, comparison, duplicates,
    anomalies, owner attention and "no action needed", from one budgeted Lexware load.
  - Data quality as GOOD/LIMITED/POOR/NO_DATA from counted findings with documented thresholds (no score).
  - Loader options `enrichOnly` / `detailsOnly` to read details and payments only for selected documents, and
    `seedFrom` to enrich the list of an earlier snapshot without reading it again.
- **Finance truth layer (Phase 2, PR 1)** — `src/finance/`: canonical, read-only finance data model with explicit
  missing-value semantics (a missing amount is never turned into 0), per-value provenance and quality
  (STRUCTURED / DERIVED / UNVERIFIED / PLACEHOLDER / CONFLICT / MISSING), deterministic data-quality issues,
  exact integer-cent amounts, Europe/Berlin calendar days, and a budgeted loader that reads Lexware only through
  a frozen GET-only client facade with a path allowlist (`src/lexware/read-only-client.ts`). No new MCP tool
  exposes it yet (that follows with the finance intelligence PR).
- **`get-server-info`** (read tier, local): build commit (`RENDER_GIT_COMMIT`), active tiers, exact list and count
  of registered tools incl. write-capable ones — to verify what a deployment really exposes (e.g. a stale client
  tool list vs. a misconfigured server). Never returns secrets; does not call Lexware. The startup log line now
  also carries `build=<sha|unknown|invalid_format>`.
- **LU'S expense read pipeline** (already deployed; documented here): signature-verified
  `POST /webhooks/lexware` receiver (`LEXWARE_WEBHOOK_PUBLIC_KEY`, RSA-SHA512, fail-closed 503 without key)
  that queues `voucher.created` events in an in-memory pending queue; read tools
  `get-pending-voucher-events`, `reconcile-recent-vouchers` (queue vs. Lexware creation dates) and
  `get-voucher-file-text` (original-PDF text via `pdf-parse` 2.4.5, page count, SHA-256); drafts-tier
  `ensure-lus-voucher-webhook` (fixed target only, no URL/event input) and `acknowledge-voucher-event`
  (local queue only).
- **LU'S AI-company foundation** (`ai-company/`, `.claude/`): Cloud CEO skill/agent, 19 boards with
  least-privilege profiles, independent reviewers, deterministic governance core (status certification,
  review loop capped at 3 fix rounds, separation of duties, Phase-1 action policy), PreToolUse guard hook,
  Claude Code deny/ask rules for all Lexware write tools, dependency-free secret/business-data scanner.
- Tests: `tests/finance-policy.test.ts` (frozen production write surface, read-only guarantees of the
  expense pipeline, pending-queue idempotency, fixed-target webhook tool) and `tests/governance.test.ts`.
- CI: least-privilege `GITHUB_TOKEN`, governance typecheck, secret scan, separate prod-dependency audit,
  dependency review, CodeQL; PR template; code owners for safety-gate files.

### Security
- **Due dates:** a stated payment term only marks a due date as reliable when voucher day + term = due day.
- **Least privilege for the finance read facade:** `/v1/contacts` and `/v1/profile` removed from
  `FINANCE_READ_PATHS` (the finance pipeline never reads them).
- **Public-repo hygiene:** test fixtures from PR 1 contained amounts and second-precise timestamps taken over from
  real Lexware documents (no names or ids); they are replaced by invented values.
- **PDF input hardening** for `get-voucher-file-text` (and the finance loader): 10 MiB download limit (aborted
  while streaming, re-checked after download), parsing in an isolated worker thread (256 MB heap limit, empty
  environment, output discarded, terminated after 15 s or when the process memory grows by more than 384 MB — a
  hostile PDF no longer blocks the event loop, and its memory use is bounded by that watchdog; measured peak about
  500 MB process RSS, so instance sizing still has to be confirmed), one parse at a time (fail fast with
  `parser_busy` instead of queueing),
  first 20 pages only, capped text, and extracted text returned as UNTRUSTED content
  (control/bidi/zero-width/tag/variation-selector characters removed, markup, URL schemes and `www.` links
  neutralized, nonce-delimited block with a fixed "data, not instructions" preamble).
- **Lexware client:** request paths with `.`/`..` segments (incl. percent-encoded, encoded separators and `..;`),
  backslashes, TAB/CR/LF, percent-encoded control characters (e.g. `%00`) or malformed/overlong percent-encoding
  are refused before sending; a malformed `maxBytes` is refused instead of meaning "unlimited".

### Changed
- `get-voucher-file-text` output: all previous `structuredContent` fields are kept; new fields `pagesParsed`,
  `pageLimitApplied`, `untrustedContent`, `contentWarning`, `limits`. Behaviour changes: `mimeType` is normalized
  (parameters stripped, lower-cased, `null` if malformed), `extractedText` is sanitized/neutralized (e.g. `<` → `‹`,
  `https:` → `https[:]`), character counts are code points, and pdf-parse page markers are no longer included —
  a scanned PDF without a text layer is now correctly reported as OCR_REQUIRED. New `extractionStatus` values: `parse_timeout`,
  `parser_busy` (all parser slots in use; retryable, says nothing about the file) and `file_too_large`.
- **Dependency hardening:** semver-compatible updates of vulnerable transitive dependencies
  (incl. critical `proxy-addr` 2.0.8, `qs`, `body-parser`, `fast-uri`, `ip-address`, `@hono/node-server`, `hono`,
  `postcss`, `nanoid`, `source-map-js`, `browserslist`, `brace-expansion`) and a scoped override that gives
  nodemon (skybridge dev-server peer) `chokidar@4`, removing the unpatched `braces` chain. Production audit
  (`--audit-level=high`) is clean; one low advisory remains (esbuild, Windows dev server only). Analysis:
  `ai-company/audit/2026-10-06-dependency-audit.md`.
- **MCP SDK 1.32.1:** `@modelcontextprotocol/sdk` raised from 1.29.0 to `^1.32.1` (GHSA-6qxp-vccf-f47h, high,
  OAuth client; the server never loads the SDK client, verified by runtime trace). OAuth/bearer behaviour and
  `tools/list` are byte-identical to 1.29.0 in a local runtime comparison.

### Fixed
- **No PII in logs:** the OAuth verifier no longer logs `sub`, `email` or `email_verified` on every
  request (regression test added).
- Stale tests: tier-registration lists now include the LU'S tools; `pagedResult` expectations match the
  row-exposing output.

## [0.1.7]

### Added
- **Line items expose `optional` and `alternative`** on every document create tool (invoice, quotation,
  credit-note, order-confirmation, delivery-note — shared `lineItemSchema`). `optional` marks an optional
  position (shown with its price but not counted in the total); `alternative` marks an alternative position.
  Both are string-coercible and forwarded to the Lexware API. Previously these lexoffice fields weren't
  modelled, so the model had no way to know it could set them.

## [0.1.6]

### Fixed
- **Removed the non-functional `archived` param from create-contact / update-contact.** `archived` is
  **read-only** on the Lexware contacts API (confirmed against the docs and live: a `PUT` with
  `archived:true` is accepted and bumps the version but leaves the contact active). The param silently did
  nothing and misled the model into thinking it could archive/hide contacts. Archiving a contact is a
  web-app-only action; there is no contact delete via the API.

## [0.1.5]

Hardening pass from a code review of 0.1.4.

### Fixed
- **Error-body reads are now classified too.** A failure while reading a non-2xx response body
  (connection reset / timeout mid-stream) previously threw a raw `TypeError`; it now yields a
  `LexwareApiError` carrying the real HTTP status, so a 404 stays a 404 and idempotent-delete handling
  keeps working.
- **`create-draft-*` fails loudly on a stale `finalize=true`.** After finalization moved to the
  dedicated `create-finalized-*` tools, a client still sending `finalize:true` had it silently stripped
  and got a draft + success. The draft tools now reject `finalize`/`confirm_finalize` with a clear
  pointer to `create-finalized-*`.
- **One-off voucher `contactName`** now also sets `useCollectiveContact:true` (lexoffice pairs a custom
  contact name with the collective contact), so switching a referenced voucher to a one-off name doesn't 406.
- **Base64 validation** no longer rejects non-canonical (but universally decodable) padding, and validates
  via a charset+length check instead of re-encoding the whole payload (cheaper for multi-MB uploads).
- **Delete tools** return an `alreadyAbsent` flag so callers can tell "deleted it" from "it never existed".

### Changed
- **The raised upload body limit no longer widens the pre-auth surface.** The 12 MB JSON parser is mounted
  on `/mcp` *after* the auth gate; other routes keep the ~100 KB default. An unauthenticated request can no
  longer force a multi-MB parse. The limit is applied via an in-place handler swap (robust to Express
  internals), and if it can't be applied the server now logs a loud WARNING instead of a quiet token.
- **Webhook event subscriptions moved to the finalize tier** (create + delete, gated together, off by
  default): a webhook streams financial events to an arbitrary external URL, so it's now opt-in rather than
  available by default.
- **`additionalFields` is now on every create tool** (contacts, articles, vouchers, documents), not just
  documents, closing the same silent top-level-strip data loss everywhere. Reserved control keys
  (`finalize`, `version`, `id`, …) are stripped from it so they can't be smuggled into a request body.
- Finalize force-enabling drafts, and a failure to raise the body limit, now emit explicit startup WARNINGs.

## [0.1.4]

### Fixed
- **Large file uploads no longer fail.** `upload-file` / `upload-voucher-file` bodies over ~75 KB were
  rejected before reaching the tool, because Skybridge pre-applies `express.json()` at body-parser's
  ~100 KB default. The JSON body limit is now raised to 12 MB, so multi-MB receipts upload as documented.
- **`get-document`** dispatches `voucherType: "recurringtemplate"` (a value the voucherlist returns) to
  `/v1/recurring-templates/{id}` instead of throwing "Unknown voucherType".
- **`update-voucher`**: passing a one-off `contactName` now clears the `contactId` carried over from the
  current voucher (they can't coexist — lexoffice 406 `custom_contact_name_for_referenced_contact_not_allowed`).
  Its `version` param now also accepts a string-serialized number, like the other update tools.
- **Base64 uploads are validated** — a malformed payload (e.g. a leftover `data:…;base64,` prefix) is
  rejected with a clear error instead of silently uploading corrupt bytes.
- **`confirm_finalize`** accepts the string `"true"` from clients that serialize booleans as strings
  (finalization was previously unreachable for them).
- **`summarize-vouchers`** reports the correct `pagesScanned` when the `maxPages` cap is hit (was off by one).
- **HTTP client**: a failure while reading a response body (timeout/reset mid-stream) is mapped to a
  classified `LexwareApiError` instead of leaking a raw `DOMException`/`TypeError`; abandoned response
  bodies are drained before a retry so keep-alive sockets are reused; a long plain-text error body is
  truncated (not dropped); the HTTP-date `Retry-After` path uses the injectable clock.
- **Idempotent deletes**: `delete-article` / `delete-event-subscription` treat a 404 as already-gone
  instead of reporting a false failure when a retried delete's first attempt already succeeded.
- Empty list results render `page 1/1` instead of the impossible `page 1/0`.
- Static-bearer `401` responses include a `WWW-Authenticate` challenge (RFC 9110).

### Changed
- **Finalization is now only via the dedicated `create-finalized-*` tools.** The `finalize` /
  `confirm_finalize` flags were removed from `create-draft-*` (a legally-binding write must never be a flag
  on a draft tool). One-step issuing still works — call `create-finalized-<type>` (finalize tier).
- **Enabling the finalize tier now also enables drafts**, so a deployment can never expose only the
  irreversible `create-finalized-*` tools with no safe draft path.
- **`delete-event-subscription` moved to the drafts tier**, symmetric with `create-event-subscription`:
  unsubscribing just stops a webhook and is trivially recreatable.
- OAuth authorization/token/registration endpoints in the AS metadata are now **overridable**
  (`OAUTH_AUTHORIZATION_ENDPOINT`, `OAUTH_TOKEN_ENDPOINT`, `OAUTH_REGISTRATION_ENDPOINT`); WorkOS-layout
  defaults are unchanged, so non-WorkOS issuers (Auth0, Keycloak) can advertise correct endpoints.
- An OAuth request from a disallowed email domain returns **403** (valid token, not authorized) instead of
  401, which made some clients loop re-authenticating.
- Advertised MCP server version bumped to **0.1.4**.

### Added
- **`additionalFields`** escape hatch on document create tools: valid Lexware body fields not modeled by the
  schema (e.g. `xRechnung`) can be passed and are merged into the request, rather than being silently
  stripped by the SDK's strip-mode top-level object.
- Startup warning when `/mcp` is unauthenticated.

### Security
- `create-event-subscription` requires an `https://` `callbackUrl` (matches Lexware's Grade-A HTTPS
  requirement), and `delete-event-subscription` is available whenever create is — so a webhook opened by,
  e.g., prompt-injected content can always be removed.

## [0.1.3]

### Added
- `summarize-vouchers` (read tier) — server-side aggregation over the voucherlist for a date range:
  paginates all matches and returns counts plus summed **gross** (`totalAmount`) and **open**
  (`openAmount`) amounts, grouped by `voucherType` / `voucherStatus` / `month` / `contact` / `currency` /
  `none`. Avoids blowing the token limit on large ranges (no per-row dump). The net/VAT split is not in the
  voucherlist, so this reports gross only. A `maxPages` cap (default 40 × 250) flags `truncated` if hit.

### Changed
- Advertised MCP server version bumped to **0.1.3** so clients pick up the new `summarize-vouchers` tool.

## [0.1.2]

### Changed
- Advertised MCP server version bumped to **0.1.2** — the tool surface shrank (65 → 59) after
  removing the non-functional `update-draft-*` tools; the version change also nudges MCP clients to
  drop the stale tools from a cached tool list.

### Added
- `paymentConditions` on every `create-draft-*` / `create-finalized-*` document body
  (`paymentTermLabel` + `paymentTermDuration` in days). The payment term can now be set at
  creation; previously the field was silently dropped (it was not in the input schema), so
  invoices fell back to the account default ("Zahlbar sofort, rein netto").

### Removed
- `update-draft-<type>` for invoices/quotations/credit-notes/order-confirmations/delivery-notes/
  dunnings. These always failed with **404 Not Found**: the Lexware Office REST API exposes only
  GET and POST for those document types — there is no PUT/update endpoint (unlike
  contacts/articles/vouchers, whose update tools remain). A draft document cannot be patched after
  creation; set all fields at creation via `create-draft-*`, or recreate the draft and delete the
  old one in the web app.

## [0.1.1]

### Added
- Advertised MCP server version bumped to **0.1.1** — reflects the expanded tool surface
  (41 → 65 tools) and the read-modify-write update tools; the version change also nudges MCP
  clients to refresh a stale cached tool list (e.g. so `update-contact`/`create-contact`
  pick up the `addresses` and `company.vatRegistrationId`/`taxNumber`/`allowTaxFreeInvoices` fields).
- **Files & PDF (binary) support** — the client now speaks binary, not just JSON:
  - `download-file` (GET a stored file) and document `render-<type>-pdf`
    (invoice/quotation/credit-note/delivery-note: render via `/document`, then download)
    return the bytes inline as MCP embedded resources.
  - `upload-file` and `upload-voucher-file` send `multipart/form-data` (file as base64 in).
- **Bookkeeping vouchers** — `create-voucher`, `update-voucher`, and `upload-voucher-file`
  (attach a receipt) for manually-booked sales/purchase transactions.
- **Document draft-updates** — `update-draft-<type>` for the six writable document types
  (optimistic locking via `version`).
- `list-recurring-templates` (read) and `delete-article` (finalize tier, destructive).
- Two new `LexwareClient` methods — `getBinary` and `postMultipart` — sharing the existing
  rate-limit/retry transport; multipart deliberately omits `Content-Type` (fetch derives the boundary).

### Added — initial release
- Initial open-source release of the Lexware Office MCP server (Skybridge MCP App) —
  a remote/hosted, OAuth-capable connector for the Claude app, claude.ai web, and ChatGPT.
- **Tiered tools** across read / draft / finalize:
  - **Read** (always on): profile; contacts & articles (list/get); voucherlist; full
    documents (invoices, quotations, credit notes, order confirmations, delivery notes,
    dunnings, down-payment invoices, vouchers); payments; reference data (countries,
    payment conditions, posting categories, print layouts); recurring templates; event
    subscriptions; document deeplinks.
  - **Drafts/writes** (`LEXWARE_ENABLE_DRAFTS`, on): create draft invoices/quotations/
    credit-notes/order-confirmations/delivery-notes/dunnings; create & update contacts and
    articles (optimistic locking); create event subscriptions.
  - **Finalize** (`LEXWARE_ENABLE_FINALIZE`, off): issue legally-binding finalized
    documents (confirmation-gated); irreversible deletes (e.g. delete event subscriptions).
- Authentication on `/mcp`, fail-closed, in two modes:
  - **Static bearer token** (`MCP_AUTH_TOKEN`) for Claude Code/Desktop.
  - **OAuth 2.1** (`OAUTH_ISSUER`, …) via any provider (e.g. WorkOS AuthKit) — exposes
    `/.well-known/oauth-protected-resource`, validates JWT access tokens against the
    provider's JWKS, and optionally restricts `OAUTH_ALLOWED_EMAIL_DOMAINS` (enforced
    server-side). Enables use as a custom connector in the Claude app and on claude.ai web.
- `~2 req/s` rate limiting with 429/`Retry-After` backoff, and capability tiers via env flags.
- Docker image, `docker-compose.yml`, Cloud Run guide, CI, and tests.

### Known limitations
- A few write shapes are typed leniently and carry `VERIFY` notes pending confirmation
  against live data: bookkeeping-voucher fields, the file-upload `type` field, and whether
  document draft-updates use optimistic-locking `version`. Wrong guesses surface as a clean
  4xx (`LexwareApiError`), never silent data loss.
- `render-<type>-pdf` is wired for invoice/quotation/credit-note/delivery-note; dunning,
  order-confirmation, and down-payment rendering await a read-only live check of `/document`.
