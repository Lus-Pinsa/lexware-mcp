This is an open-source MCP server for the Lexware Office API, built with the Skybridge
framework. When planning or updating the codebase, use the `skybridge` skill.

Key conventions:
- Keep all Lexware logic (`src/lexware`, `src/config.ts`, `src/tools`) independent of Skybridge.
- Tools are gated by capability tiers in `src/config.ts` and registered conditionally in
  `src/tools/index.ts` (read = always; drafts/finalize = env-gated).
- Finalizing is irreversible: any legally-binding write must be a separate, confirmation-gated
  finalize-tier tool — never a flag on a draft tool.
- `npm run build` typechecks; `npm test` runs vitest. Never log secrets or PII.

## LU'S AI company (multi-agent foundation)

This repository also hosts the LU'S AI-company foundation (`ai-company/`, `.claude/`). Start at
`ai-company/README.md`.
- Business requests in natural language → use the `cloud-ceo` skill (`.claude/skills/cloud-ceo/SKILL.md`).
- Hard rules: `.claude/rules/ai-company-hard-rules.md`. Phase 1 = no productive writes.
- Safety gates (`.claude/settings.json`, `.claude/hooks/guard.mjs`, `.github/workflows/`, `CODEOWNERS`)
  must not be weakened; the guard hook blocks edits unless a human enables maintenance.
- `tests/finance-policy.test.ts` freezes the server-side write surface; `tests/governance.test.ts`
  enforces the org registry, permissions and the review loop. Both must stay green.
- `npm run typecheck:governance` typechecks `ai-company/core`; `npm run secret-scan` scans for
  secrets and business data (this repository is public).
