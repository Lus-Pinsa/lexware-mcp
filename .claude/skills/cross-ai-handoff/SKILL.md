---
name: cross-ai-handoff
description: Prepare or independently verify evidence-based handoffs between ChatGPT and Claude for LU'S AI Company. Use for Monday reviews, cross-agent collaboration, takeover of a PR stack, stalled work or a release decision.
---

# Cross-AI handoff: independently verifiable collaboration

Purpose: enable **one implementation / an independent review**, not the illusion that multiple model answers are independent when they reuse each other's conclusions.

## Source of truth (read at invocation)
1. Inspect `AGENTS.md`, `ai-company/README.md`, hard rules and the actual PR/branch state via GitHub.
2. Resolve commit SHAs, base branches, merge status, linked dependencies and last CI/CodeQL results **for the current head SHA**.
3. Read actual changed files and prior review comments; distrust status summaries, transcripts or agent claims until independently verified.
4. A reviewer must be a different actor/session from the builder and must not inherit a GREEN verdict from the handoff.

## Author a handoff
Fill `ai-company/github/HANDOFF_TEMPLATE.md` with current evidence and a UTC timestamp. All proposed actions are categorised:
- **EXECUTABLE NOW:** read-only checks, safe tests and draft-branch work allowed under existing policies.
- **BLOCKED / OWNER ONLY:** secrets, changed credentials, paid plans, production config, migrations, finance writes, merges and protected files requiring approval.
- **UNKNOWN:** not independently verified; describe the exact evidence needed.

Every handoff includes:
- Repository/main/head SHA, stacked PR graph, alternatives not to merge, conflict risks.
- Changes since previous handoff, with source links.
- Exact tests/build/CodeQL and the tested SHA; count failed/pending/skipped checks.
- Unresolved findings, severity, file/line and a reproducible scenario.
- Next two scoped tasks with acceptance criteria and independent reviewer assignment.
- Explicit owner questions, if any; if none, say "Keine".
- Whether Claude or ChatGPT actually ran; never imply an external model received, reviewed or worked on the handoff merely because a file was written.

## Monday review contract
The designated reviewing actor first reproduces evidence, then performs a **fresh adversarial pass** on auth, permissions, tenant isolation, data integrity, recovery and integration boundaries. For each finding give severity, evidence, reproduction/test, affected commit and proposed fix. No reviewer may unilaterally merge or deploy.

## Output
`STATUS: GREEN | YELLOW | RED | BLOCKED`
`BUILDER: <verified actor/session or unknown>`
`REVIEWER: <different actor/session or pending>`
`CURRENT HEAD / CI / CODEQL: <SHA and links>`
`NEW FINDINGS / RESOLVED FINDINGS / BLOCKERS / NEXT ACTION / OWNER DECISION`

Follow `.claude/rules/ai-company-hard-rules.md` and the max-three-fix-round policy. Never expose confidential LU'S data in this public repository.
