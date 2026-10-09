---
name: release-evidence-gate
description: Independently assess whether LU'S AI Company pull requests or a stack are eligible for review, merge authorisation, migration or release. Use before promoting a Draft PR, owner approvals, preparing a deployment, or claiming CI/security readiness.
---

# Evidence gate: do not confuse automated checks with release approval

## Baseline
Read `AGENTS.md`, `CODEOWNERS`, `.github/workflows/`, `ai-company/policies/review-loop-and-escalation.md` and `.claude/rules/ai-company-hard-rules.md`. The protected `main` branch is not modified by this skill.

For each PR, independently verify:
1. **Graph**: exact head/base SHA, ancestor relationship, canonical branch chain, competing implementation, changed files, conflicts and intended merge order. Do not merge alternate persistence paths together without an approved design.
2. **Safety**: secrets/PII absent from this public repository, least-privilege permissions, audit immutability, read-only defaults, finance writes gated, approved dependencies and no weakening of guard hooks/branch protection.
3. **Tests**: test assertions are substantive, original baseline failures repaired correctly, all mandatory GitHub checks tied to current SHA; quote log counts and link failures. `success` on an earlier SHA is not approval.
4. **Independence**: builder, domain/security reviewer and deterministic CI are distinct. Gather actual review feedback; self-review and green CodeQL alone are insufficient.
5. **Persistence**: real PostgreSQL adversarial tests, backup/restore, transaction/tenant isolation, and migration rollback assessed when SQL or durable storage changed.
6. **Supply chain**: evaluate workflow permissions, use of untrusted PR content, immutable action pins and dependency provenance before adding third-party actions or Claude automation.
7. **Operations**: distinguish drafted code, merged code, configured service, and working production integration; each requires different evidence.

## Owner-only gate
NEVER merge, modify protected branch settings, change deployed Render infrastructure, create paid resources, process real Lexware writes, expose secrets, apply migrations or activate automated external agent actions without a **separate explicit owner decision**. Mark these `OWNER APPROVAL REQUIRED`; do not treat prior broad project permission as production consent.

## Verdict categories
- `REVIEW-READY`: all local PR checks and evidence are complete but independent reviewers/owner still pending.
- `MERGE-ELIGIBLE / OWNER PENDING`: current-head mandatory CI/CodeQL pass, reviewer approval, dependency chain verified; no production claim.
- `BLOCKED`: any unresolved critical security issue, failed gate, conflicting implementation, missing evidence or owner-only setting.
- `DEPLOY-VERIFIED`: only after approved deployment and independent operational evidence; never inferred from tests.

## Output
`VERDICT / CURRENT SHA / CHECKS / REVIEWERS / DEPENDENCIES / RISKS / APPROVAL NEEDED / EXACT NEXT ACTION`

The creator must not independently certify the release; obey the 3-round review cap.
