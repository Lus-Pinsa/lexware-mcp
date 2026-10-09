# LU'S AI Company — cross-AI handoff template

> **Template only.** Filling this document does not schedule, connect, invoke or prove that Claude or ChatGPT ran. Never record private accounting/customer data in the public repository.

**Captured at (UTC):** YYYY-MM-DDTHH:mm:ssZ
**Prepared by:** actor/session (or UNKNOWN)
**Independent reviewer:** actor/session (or PENDING)
**Review purpose:** Monday audit / PR takeover / emergency / release gate

## 1. Current baseline
- Repository:
- Main branch SHA:
- Canonical persistence path / excluded competing path:
- Draft PR stack (PR -> base -> head SHA -> dependency):
- Open security/blocking findings and links:

## 2. What changed since last handoff
| PR / commit | Change | Evidence | Confirmed merged? |
|---|---|---|---|
| — | — | GitHub link | No / Yes |

## 3. Executed verification (no inferred GREEN)
| Head SHA | Test/CI/CodeQL/DB drill | Actual outcome | Run/log |
|---|---|---|---|
| — | — | PASS / FAIL / NOT RUN / BLOCKED | URL |

## 4. Fresh adversarial review required
- Security/auth/permissions:
- Tenant isolation/RLS:
- Audit ordering, hash canonicalization and retention:
- Webhook durability/retry/restore:
- Database schema migration compatibility:
- Third-party dependencies and workflow privileges:
- Finding format: **severity, exact file:line/PR, reproduction, potential impact, acceptance test**.

## 5. Work allocation and boundaries
| Scoped task | Builder | Independent reviewer | Acceptance evidence |
|---|---|---|---|
| — | ChatGPT or Claude | Different actor | Tests + review + CI |

**Safe without owner:** read-only checks, test authoring and draft PRs within policy.

**Owner-only:** merges, migrations, production credentials, configuration changes, paid tools and Lexware writes.

## 6. Blocking decisions
- Required from owner: **NONE** or a precise setting/choice with impact and direct link.
- Pending technical evidence:
- Next update trigger:

## 7. Final status
**STATUS:** GREEN / YELLOW / RED / BLOCKED (with evidence)
**IMPLEMENTED / MERGED / DEPLOYED:** mark each independently
**NEXT SAFE STEP:**
