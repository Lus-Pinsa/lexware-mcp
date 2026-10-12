# AgenticOS + Claude Code — LU'S AI Company

Status: **design-only / not installed**. Verified against official upstream
documentation on 2026-10-13. This file authorizes **no** runtime actions.

## Decision: two separate products, complementary roles

- **Claude Code** is our code author, test operator and independent-review
  orchestration surface in this repository. Its existing project guard hook
  and hard rules remain authoritative. Start the owner's explicit review
  workflow in Claude Code with `/agenticos` after the skill is available in
  the checked-out project.
- **AgenticOS** is a separate, self-hosted control plane for business agents:
  Python backend and frontend, Postgres with pgvector, Redis, Prefect workers,
  and optional sandbox runtime. Anthropic/Claude is one possible model
  provider, **not** an extension of an existing Claude Code login.
- Its documented MCP functionality **consumes remote MCP servers**. The
  reference material reviewed does not prove that AgenticOS itself exposes
  a compatible Claude Code MCP server. Do **not** register an invented
  AgenticOS endpoint in Claude's MCP configuration.
- AgenticOS can export an agent's configuration to YAML for repository
  review. Such an export requires a real instance and a separate approval
  before any instance is created. No unverified YAML schema is invented here.

Vendor documentation:
- https://github.com/vstorm-co/agenticos
- https://vstorm-co.github.io/agenticos/about/claude-code/
- https://vstorm-co.github.io/agenticos/install/
- https://vstorm-co.github.io/agenticos/mcp/
- https://vstorm-co.github.io/agenticos/security/
- Claude Code skills: https://code.claude.com/docs/en/skills

## Safe integration stages

| Stage | Scope | Gate / outcome |
| --- | --- | --- |
| 0 — project integration | Manual Claude project skill, this ADR, static CI test | No deployment, credentials or tool permission changes |
| 1 — vendor/security review | Check pinned release, license, compose/service topology, data paths, SSRF and sandbox/approval model | Independent security review and owner-approved target environment |
| 2 — isolated proof of concept | **Only if separately authorized:** non-production local isolated host, no real data, no external integrations, no exposed ports; pinned release; strict resource budget | Exact installation commands, egress and cost disclosure approved by owner first |
| 3 — synthetic agent | Internal FAQ using invented reference documents with citations, read-only capabilities and zero outbound business actions | Test retrieval, source attribution, auth boundaries, audit log, cost ceiling and shutdown |
| 4 — production proposal | Architecture, threat model, secret custody, data retention, legal/compliance, tenant segregation, backups, HA and operating cost | Luigi's explicit decision; no implicit rollout |

**No Stage 2+ action is authorized by merging Stage 0.** Never run an
uninspected upstream installation shell script in this project, especially
not a download piped directly into a shell. The Docker bootstrap can
create containers, volumes, network interfaces and migrations and may expose
services. The optional sandbox component can hold the Docker socket.
A local proof of concept therefore needs isolation and an explicit owner gate.

## Initial pilot contract (synthetic FAQ)

- Inputs: short artificial FAQ documents containing **no** staff, guest,
  supplier, finance, Lexware or restaurant business information.
- Output: an answer with document citation; unsupported questions must state
  that the information was not found.
- Disabled: Lexware/Render/GitHub mutation, live MCP connections, outbound
  messaging, scheduling, file sync, self-modifying skills, delegation and
  external publishing.
- No shared `.env` files, tokens, model credentials, production Postgres
  volumes, GitHub privileges, or Mac host filesystem mounts.
- Tests: known-answer and unknown-answer prompts, simulated malicious
  source instructions (prompt injection), tenant boundary attempts,
  unauthorized write requests, audit visibility and shutdown/rollback.
- Capture evidence: pinned source revision/image digest, explicit config
  diff, synthetic fixtures, observed test runs, resource usage and a separate
  reviewer's approval.
- No inference of "free": Apache-2.0 licensing is separate from hardware,
  hosting, provider/API, model and third-party service costs.

## Review and rollback gates

**Required independent review (not initiated by this file):**
1. Security: Docker socket, container privilege, inbound/outbound networking,
   defaults, credential vault, browser/API exposure, data privacy, MCP
   allowlists and supply-chain verification.
2. Architecture: whether AgenticOS adds value over existing LU'S agents,
   governance ownership, tenant boundaries and simple migration/exit path.
3. QA: isolated test with synthetic data only, reproducible outcomes,
   approvals enforced server-side, documented stop/delete of temporary
   resources **only when those resources have been explicitly authorized**.

Owner decisions **before** any install: approve the precise host/location,
network isolation, pinned release, permitted model/provider and maximum
financial exposure. A Claude subscription must not be assumed to cover
Anthropic API billing. Never request keys in chat or commit them to GitHub.
Keep all changes in Draft PRs; never auto-merge.

## Current evidence

Stage 0 is only a repository-local design and a manually invocable Claude
Code skill, subject to CI and independent review. Neither the actual Claude
Code client, AgenticOS runtime, a hosted endpoint nor an Anthropic provider
connection was activated by committing these files. Reviewing a PR in
GitHub does not notify or execute Claude.
