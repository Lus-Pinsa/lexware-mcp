# Independent Security Gate Audit — OpenAI

Date: 2026-10-08  
Scope: PR #6, base `8f938aa597e38d7ca70f89c60b7dba4301a5da14`, reviewed head `629ab318902898c28c18ed8aa86068a8ac88a517`.

## Verdict

No new CRITICAL, HIGH or MEDIUM implementation defect was identified in the reviewed PR-6 delta beyond the already documented gate items.

The gate is still **NOT READY TO MERGE** while **SUP-01 HIGH** remains open: the live GitHub ruleset does not yet enforce all security checks / CodeQL server-side. Known `SAG-02` (read-only default) and `SAG-06` (PDF worker isolation) remain explicit decision/future items and were not silently changed.

Agents must not merge this PR. Merge remains an Owner action.

## Verified evidence at reviewed head

GitHub Actions were green for:

- `build-test (typecheck, tests, governance)`
- `docker`
- `dependency-review (new dependencies in PR)`
- `audit (production dependencies)`
- `secret-scan (credentials + business data)`
- CodeQL `analyze`

Build-test ran:

- `npm run build`
- `npm run typecheck:governance`
- `npm test`
- **30/30 test files passed**
- **791/791 tests passed**

Secret scan: **160 files scanned, 0 findings**.

Production dependency audit: no HIGH/CRITICAL production vulnerability. One LOW advisory remained in Skybridge's nested esbuild development-server dependency; no unreviewed override was introduced in this gate.

## Independent review notes

### Authentication and request-body handling

- Static bearer uses constant-time comparison.
- Server fails closed without OAuth/static auth unless unauthenticated mode is explicit.
- MCP JSON parsing is deferred until after auth when Skybridge parser reconfiguration succeeds.
- MCP path detection is case-insensitive, closing the earlier `/MCP` parser mismatch.
- No new authentication bypass identified.

### OAuth

- JWT signature, issuer and default audience are verified.
- Startup fails closed without an email-domain allowlist unless `OAUTH_ALLOW_ANY_USER=true` is explicit.
- Only verified email claims / verified userinfo can satisfy domain authorization.
- Userinfo has a timeout.
- Cached bearer keys are token hashes rather than raw bearer tokens.
- Logs exclude email/sub and sanitize attacker-controlled JWT header values.

### Lexware client boundary

- Unsafe request-path normalization tricks are rejected.
- Redirects are manual, bounded, GET-only and same-origin.
- Cross-origin redirects never receive the Lexware credential.
- Echoed API keys are redacted from upstream errors.
- Non-idempotent POSTs are not retried on ambiguous transport/5xx failures.

### Webhooks

- RSA-SHA512 is verified over the exact raw body before parsing.
- Shape/type/length validation precedes queueing and logging.
- Queue is bounded and overflow is explicit.
- Organization binding is implemented and tested.

Residual: binding only becomes effective after Owner configures `LEXWARE_ORGANIZATION_ID` (O-4). Replay protection remains deduplication-based while the event is queued; no timestamp acceptance window exists yet.

### Read-only boundary

PR #6 adds no Lexware write path.

Known residual `SAG-02` remains material: if `LEXWARE_READ_ONLY` is absent, the current defaults can expose draft write tools. Changing that default is an explicit Owner decision and belongs in a small follow-up PR.

### Supply chain / platform

- Node 24 LTS runtime target.
- Docker image pinned by digest.
- Runtime user is non-root.
- Skybridge telemetry disabled in the Docker runtime.
- Secret scan, dependency review, Docker, audit and CodeQL are green.

**SUP-01 remains the merge blocker** until the live ruleset requires all security gates server-side.

## Monday / Claude handoff

Claude should not re-audit the historical project from scratch.

1. Read this audit and `ai-company/security/README.md`.
2. Compare current PR #6 head against `629ab318902898c28c18ed8aa86068a8ac88a517`.
3. Review only the delta after this checkpoint.
4. Confirm live `SUP-01` ruleset status.
5. Re-run final security audit only after Owner actions that affect the gate.
6. Do not redesign accepted architecture unless a new HIGH/CRITICAL issue is demonstrated.

## Status

- New CRITICAL: **0**
- New HIGH: **0**
- New MEDIUM: **0**
- Gate READY: **NO**
- Blocker: **SUP-01 HIGH owner action**
- Merge authority: **Owner only**
