# LU'S AI COMPANY FOUNDATION: FINAL REPORT

Datum: 06.10.2026 · Repo: `Lus-Pinsa/lexware-mcp` · Branch: `claude/busy-knuth-0980fw` ·
PR: https://github.com/Lus-Pinsa/lexware-mcp/pull/2 (Draft, **nicht gemergt**)
Öffentliches Repo: Dieser Bericht enthält keine Secrets und keine Geschäftsdaten.

---

## EXECUTIVE SUMMARY

**Was wurde gebaut?** Eine schlanke, CI-geprüfte Multi-Agent-Foundation in Claude Code:
- ein Cloud CEO (Skill + Agent) als einziger Ansprechpartner,
- 19 Boards mit Leads, Workern und Reviewern, davon 16 sofort ausführbare Agentenrollen,
- Least-Privilege-Profile,
- ein deterministischer Governance-Kern (Status nur mit Nachweis, Ersteller ≠ Prüfer ≠ CI, Review-Loop
  technisch auf 3 Fix-Runden gedeckelt, Eskalation, fail-closed Policy),
- technische Safety Gates für Agenten (`.claude/settings.json` mit Deny/Ask, PreToolUse-Guard-Hook),
- Trennung Core ↔ Customer Config,
- gehärtete CI,
- Finance-Policy-Tests, die die serverseitige Write-Fläche einfrieren.

**Was war vorhanden?** Der lexware-mcp auf Render mit dem live getesteten Expense-Read-Stack
(Webhook → RAM-Queue → Reconciliation → Voucher → Original-PDF/SHA-256 → Ampel), außerdem eine CI-Datei,
die nie gelaufen war, und 7 veraltete, rote Tests.

**Was wurde verändert?**
- Neu: `ai-company/` und `.claude/`, 2 neue Testdateien, CI-Härtung.
- **Eine Laufzeitänderung:** `src/oauth.ts` loggt keine E-Mail und keine `sub` mehr (PII-Befund des Security Boards, mit
  Regressionstest).
- Veraltete Tests repariert, Doku aktualisiert.

**Was wurde bewusst nicht verändert?**
- Lexware-Logik (Webhook, Queue, Reconciliation, PDF, Tools, Tiers): unverändert.
- Render-Konfiguration: unverändert, `LEXWARE_ENABLE_FINALIZE=false` bleibt.
- Abhängigkeiten und Lockfile: unverändert.
- Keine produktiven Writes, nichts nach `main` gemergt, keine kostenpflichtigen Dienste, keine Cron-Routinen.

**Gesamtstatus: GELB.** Die Foundation steht und ist getestet. Offen sind Owner-Aktionen (Branch-Schutz,
Dependency Graph, Render-Zugang) und eine Entscheidung zur serverseitigen drafts-Write-Fläche.

---

## ARCHITECTURE

```
Luigi
  └─ Cloud CEO (cloud-ceo; Profil orchestrator: lesen + delegieren, keine Prod-Rechte)
       ├─ Stab: Cost Governance · Escalation Desk
       ├─ Daily COO / Control Tower (daily-coo) — schlägt Aufgaben an Boards vor
       └─ Boards (flach delegiert: der CEO startet alle Agenten, Leads planen und nehmen ab)
```

| Board | Lead | Worker (Auswahl) | Reviewer | Status |
|---|---|---|---|---|
| Engineering | engineering-lead | typescript-engineer, integration-engineer, api-research-agent, test-engineer, refactoring-agent | code-reviewer | FOUNDATION READY |
| Security | security-lead | appsec-, permission-, secret-, dependency-, mcp-security-reviewer | security-auditor | FOUNDATION READY |
| QA & Audit | qa-lead | unit-, integration-, regression-, negative-test-agent, evidence-auditor | final-auditor | FOUNDATION READY |
| DevOps | devops-lead (geplant) | github-ci-agent, render-monitor, deploy-verifier, healthcheck, runtime-log-reviewer | final-auditor | PARTIAL |
| Knowledge | knowledge-steward | conflict-detector, lineage-agent | final-auditor | FOUNDATION READY |
| Finance | finance-lead | expense-agent, finance-validator, bank-reconciliation, cash, month-end | finance-auditor | FOUNDATION READY (Read-Pipeline live) |
| Treasury | treasury-lead | cash-position, obligations, cashflow-forecast | treasury-auditor | FOUNDATION READY (Struktur) |
| Costing & Menu Eng. | costing-lead | supplier-invoice, ingredient-matcher, unit-normalizer, price-history, recipe-bom, yield, waste, labor-cost, overhead-allocation, menu-engineering | costing-auditor | FOUNDATION READY (Struktur) |
| Purchasing | purchasing-lead | supplier-price, comparison, recommendation, availability | purchasing-auditor | FOUNDATION READY (Struktur) |
| HR & Payroll | hr-lead | employee-master, registration-compliance, timekeeping, payroll-prep, tax-advisor-delivery | hr-payroll-auditor | FOUNDATION READY (Struktur) |
| Daily COO | daily-coo | daily-brief-agent, blocker-tracker | final-auditor | FOUNDATION READY |
| Inventory & Prep | inventory-lead | stock, consumption, prep-forecast, waste, reorder | inventory-auditor | FOUNDATION READY (Struktur) |
| Food Safety / HACCP | food-safety-lead | temperature, cleaning, allergen, traceability, expiry, training | compliance-auditor | FOUNDATION READY (Struktur) |
| CRM | crm-lead | segmentation, retention, campaign-audience, company-customer, reactivation | privacy-auditor | FOUNDATION READY (Struktur) |
| Marketing / Social | marketing-lead | content-research, planner, instagram, caption, campaign, creative-qa | brand-compliance-agent | FOUNDATION READY (Struktur) |
| SEO / Growth | growth-lead | technical-, local-seo, search-intent, landing-page, cro, ranking-monitor | growth-auditor | FOUNDATION READY (Struktur) |
| Sales | sales-lead | lead-discovery, qualification, offer-prep, follow-up, pipeline-analyst | sales-auditor | FOUNDATION READY (Struktur) |
| Operations | operations-lead | sop, foodtruck-ops, maintenance | operations-auditor | FOUNDATION READY (Struktur) |
| Technology Radar | ai-technology-lead | release-watcher, poc-evaluator | security-auditor | FOUNDATION READY |

**Ausführbare Agenten (16):** cloud-ceo, daily-coo, engineering-lead, typescript-engineer,
test-engineer, code-reviewer, security-lead, security-auditor, qa-lead, final-auditor,
deploy-verifier, knowledge-steward, technology-radar, finance-lead, finance-auditor, board-analyst
(generisch, nur lesend, für geplante Business-Rollen ohne Datenquelle).
„(Struktur)“ bedeutet: Rollen, Rechte, KPIs, Grenzen und Review-Pfad sind definiert und CI-validiert, aber **noch keine Datenquelle**.

---

## FILES CREATED / CHANGED

| Pfad | Zweck |
|---|---|
| `.claude/agents/*.md` (16) | Rollen-Definitionen mit expliziten Tool-Listen |
| `.claude/skills/cloud-ceo/SKILL.md` | Betriebsablauf des CEO (Klassifikation, Task-Graph, Parallelität, Review-Loop, Antwortformat) |
| `.claude/rules/ai-company-hard-rules.md` | immer geladene harte Regeln |
| `.claude/settings.json` | Deny für alle Lexware-Write- und Finalize-Tools sowie Merge, Ask für Queue-Acknowledge, Hook-Registrierung |
| `.claude/hooks/guard.mjs` | PreToolUse-Gate: Finance-Writes, Publish/Send/Pay, Merge, Push auf main, Force-Push, Secrets, direkte APIs, Gate-Dateien |
| `ai-company/README.md` | Einstieg |
| `ai-company/core/org.json` | 19 Boards, Rollen, KPIs, harte Grenzen (kundenneutral) |
| `ai-company/core/permission-profiles.json` | 11 Least-Privilege-Profile und Phase-1-Verbote |
| `ai-company/core/governance.ts` | Status-Zertifizierung, Trennung der Aufgaben, Review-Loop ≤ 3, Policy |
| `ai-company/core/registry.ts` | Loader und Validierung (CI) |
| `ai-company/tsconfig.json` | Typecheck des Governance-Kerns |
| `ai-company/customers/lus/{customer.json,finance-rules.md,brand.md}` | LU'S-Konfiguration |
| `ai-company/customers/_template/customer.json` | Vorlage für weitere Gastronomen |
| `ai-company/policies/*.md` (7) | Berechtigungen, Finance-Gates, Review/Eskalation, Kosten, Source of Truth, Security, Drittanbieter |
| `ai-company/boards/catalog.md` | Board-Abläufe, Status, KPI-Ownership |
| `ai-company/radar/{sources.json,README.md}` | Technology Radar |
| `ai-company/scripts/secret-scan.mjs` | Scanner für Secrets und Geschäftsdaten, ohne Abhängigkeiten |
| `ai-company/github/ruleset-main.json` | Branch-Schutz zum Import |
| `ai-company/audit/*.md` | Inventur, Testnachweise, dieser Bericht |
| `tests/finance-policy.test.ts` | eingefrorene Write-Fläche, Read-only-Garantien, Queue-Idempotenz |
| `tests/governance.test.ts` | Registry, Rechte, Review-Loop, Policy, Hook, Settings, Scanner |
| `tests/tools.test.ts`, `tests/shared.test.ts` | veraltete Erwartungen aktualisiert |
| `tests/oauth.test.ts` + `src/oauth.ts` | PII-Fix plus Regressionstest |
| `.github/workflows/ci.yml` | gehärtet: Token-Rechte, Governance, Secret-Scan, Audit, Dependency Review |
| `.github/workflows/codeql.yml` | CodeQL security-extended |
| `.github/pull_request_template.md` | Review- und Security-Checkliste |
| `CODEOWNERS` | `@Lus-Pinsa`, Gate-Dateien explizit |
| `package.json` | Scripts `typecheck:governance`, `secret-scan` (keine neuen Abhängigkeiten) |
| `README.md`, `CHANGELOG.md`, `SECURITY.md`, `.env.example`, `AGENTS.md` | Doku-Drift behoben, AI-Company-Abschnitt |

---

## GITHUB

- **Branch:** `claude/busy-knuth-0980fw` (Basis `main` @ `b601a6c`)
- **PR:** https://github.com/Lus-Pinsa/lexware-mcp/pull/2 (Draft)
- **Commits:**

| SHA | Inhalt |
|---|---|
| `6ebe68d` | test: veraltete Tier- und pagedResult-Erwartungen |
| `163648c` | fix(security): kein PII im OAuth-Log |
| `50586f8` | test: Finance-Write-Grenze eingefroren |
| `46be074` | feat(ai-company): CEO, Boards, Governance-Kern, Gates |
| `76573d1` | ci: Härtung, CodeQL, CODEOWNERS, PR-Template |
| `3a69a7e` | docs: Lexware-Stack und Foundation dokumentiert |
| `5f9e8df` | docs(audit): Inventur und Orchestrierungstests |
| (folgt) | docs(audit): Final Audit und dieser Bericht |

- **CI (erste Actions-Läufe der Repo-Historie)** auf `3a69a7e` und `5f9e8df`:
  build-test ✅ · secret-scan ✅ · docker ✅ · CodeQL ✅ · dependency-review ❌ (Dependency Graph im
  Repo deaktiviert) · audit ❌ (transitive Altlasten, Lockfile unverändert gegenüber `main`)
- **Branch Rules:** **keine aktiv** (`main` ist ungeschützt). Die Vorlage `ai-company/github/ruleset-main.json` braucht einen Import durch Luigi.
- **Tests:** lokal 12 Dateien, **216/216 grün** (vorher 135 Tests, davon 7 rot)

---

## AGENT TESTS

| Test | Ergebnis | Nachweis |
|---|---|---|
| Delegation: CEO → Engineering + Security + QA → unabhängiger Final Auditor | **BESTANDEN**. Alle 7 Pflicht-Claims unabhängig verifiziert, keine Widersprüche | `ai-company/audit/2026-10-06-orchestration-tests.md` (F1–F4) |
| Parallelität: test-engineer (Abdeckung) ∥ technology-radar (Quellen) | **BESTANDEN**. Zeitfenster 11:53:06–11:54:25 und 11:53:07–11:54:21; zusätzlich 5 Agenten gleichzeitig | ebd. (G1/G2) |
| Failure / Retry / Eskalation | **BESTANDEN**. Live: 3 Fix-Runden gegen ein unlösbares Mock-Gate, danach harter Stopp. Der CEO lehnte die Bitte des Agenten ab, das Gate zu ändern. Deterministisch: 5 Tests in `tests/governance.test.ts` | ebd. (H1–H3) |

Einschränkung: Neue Agent-Typen laden erst nach einem Session-Neustart. Die Rollen liefen deshalb als
`general-purpose`-Subagenten mit geladener Rollendatei. Die Tool-Grenzen der Frontmatter galten per Anweisung,
Settings und Hook dagegen technisch.

---

## PERMISSIONS

| Agent | READ | WRITE | PROD | FINANCE | DEPLOY | SECRETS |
|---|---|---|---|---|---|---|
| cloud-ceo | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| engineering-lead / qa-lead | ✔ (+Tests) | ✘ | ✘ | ✘ | ✘ | ✘ |
| typescript-engineer / test-engineer | ✔ | nur Branch/PR | ✘ | ✘ | ✘ | ✘ |
| knowledge-steward | ✔ | nur `ai-company/`-Doku, Branch | ✘ | ✘ | ✘ | ✘ |
| code-reviewer / security-lead / security-auditor / final-auditor | ✔ (+Tests/Audit) | ✘ | ✘ | ✘ | ✘ | ✘ |
| deploy-verifier | ✔ | ✘ | nur lesen | ✘ | ✘ | ✘ |
| finance-lead / finance-auditor | ✔ | ✘ | nur lesen | nur lesen | ✘ | ✘ |
| daily-coo | ✔ | ✘ | nur lesen | nur lesen (Queue/Reconcile) | ✘ | ✘ |
| technology-radar | ✔ (+Web) | ✘ | ✘ | ✘ | ✘ | ✘ |
| board-analyst | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |

Durchsetzung: Agent-Tool-Listen und CI-Abgleich gegen die Profile, `settings.json` (deny), `guard.mjs`,
serverseitige Tiers. Kein Profil hat in Phase 1 Finance-, Prod- oder Deploy-Write oder Zugriff auf Secrets. Das prüft CI.

---

## SECURITY

**Vorhandene Gates:** TypeScript-Build und Governance-Typecheck · 216 Tests (Unit, Negativ, Permission,
Idempotenz, Finance-Policy, Hook) · Secret- und Business-Data-Scan · Prod-Dependency-Audit · Dependency
Review · CodeQL · `permissions: contents: read` · Guard-Hook (live belegt) · Settings-Deny (live belegt) ·
CODEOWNERS · serverseitige Tiers (Finalize aus) · Webhook-Signaturprüfung · kein PII im OAuth-Log.

**Nicht vorhanden:** Branch-Schutz/Ruleset (Owner) · Dependency Graph/Dependabot-Alerts (Owner) · natives
Secret Scanning/Push Protection (nicht prüfbar, Owner) · Webhook-Tests, Replay-Schutz, organizationId-Abgleich ·
serverseitige Einschränkung von `create-voucher`/`update-voucher` · Pflicht-E-Mail-Allowlist bei OAuth ·
Markierung „untrusted data“ für PDF-Text · Audit-Log außerhalb von Git.

**Restrisiken:** siehe Abschnitt Handover.

---

## CONNECTORS

| Connector | Status | Testmethode |
|---|---|---|
| GitHub | **VERIFIZIERT** | GitHub-MCP (get_me, Branches, Workflows, Runs, Job-Logs, PR anlegen, Kommentar), git push auf den Feature-Branch |
| Render | **BLOCKIERT** | kein Render-Connector; HTTPS zu `onrender.com` vom Egress-Proxy der Umgebung abgelehnt (403); nur indirekt lebendig (Lexware-Connector antwortet) |
| LU'S Lexware | **VERIFIZIERT (nur lesend)** | get-profile, list-event-subscriptions, get-pending-voucher-events, reconcile-recent-vouchers, get-voucher, get-voucher-file-text. Kein Write-Tool aufgerufen |

---

## EXISTING LEXWARE STACK

| Komponente | Status | Nachweis |
|---|---|---|
| Webhook (`voucher.created`) | **AKTIV**: genau 1 Abo auf den festen Callback | list-event-subscriptions (live) |
| Pending Queue | **FUNKTIONSFÄHIG**, zum Prüfzeitpunkt leer (RAM) | get-pending-voucher-events (live), Idempotenz-Test |
| Reconciliation | **FUNKTIONSFÄHIG, READ-ONLY** | reconcile (live), Test: nur GET /v1/voucherlist |
| Original-PDF | **FUNKTIONSFÄHIG** (Text, Seitenzahl) | get-voucher-file-text (live) |
| SHA-256 | **FUNKTIONSFÄHIG** | live und Test mit bekanntem Hash |
| Expense Read Pipeline | **INTAKT**, Code unverändert | `git diff b601a6c..HEAD -- src/` betrifft nur `oauth.ts` |

Keine produktiven Write-Tests. `LEXWARE_ENABLE_FINALIZE=false` bleibt erhalten, belegt über die Tool-Liste des Connectors.

---

## BOARD STATUS

| Board | Status |
|---|---|
| Finance | FOUNDATION READY (Read-Pipeline live) |
| Treasury | FOUNDATION READY (Struktur, keine Bankdaten) |
| Costing | FOUNDATION READY (Struktur, kein POS und keine Rezepte) |
| Purchasing | FOUNDATION READY (Struktur) |
| HR | FOUNDATION READY (Struktur, keine Zeiterfassung) |
| Daily COO | FOUNDATION READY (nur Finance-Daten verfügbar) |
| Inventory | FOUNDATION READY (Struktur) |
| HACCP | FOUNDATION READY (Struktur) |
| CRM | FOUNDATION READY (Struktur) |
| Marketing | FOUNDATION READY (Struktur, Brand-Datei leer) |
| SEO | FOUNDATION READY (Struktur) |
| Sales | FOUNDATION READY (Struktur) |
| Operations | FOUNDATION READY (Struktur) |
| Engineering | FOUNDATION READY |
| Security | FOUNDATION READY |
| QA | FOUNDATION READY |
| DevOps | PARTIAL (kein Render-Zugang) |
| Technology Radar | FOUNDATION READY |

---

## MULTI-TENANT / PRODUCTIZATION

**Getrennt:** Der Core (`ai-company/core`: Org, Profile, Governance) enthält keine Kunden- oder Vendor-Namen, CI prüft das.
Kundenspezifisch sind Connectoren, die Zuordnung Capability → Tool, Sources of Truth, Kalender und Finance-/Brand-Regeln
(`customers/lus`). Eine Vorlage liegt in `customers/_template`. KPIs gelten nur als messbar, wenn die Quelle in der Customer Config verifiziert ist.

**Noch LU'S-hardcoded:**
- `src/tools/event-subscriptions.ts`: fester Callback `lus-lexware-mcp.onrender.com`. Tool-Name und
  Beschreibungen nennen „LU'S“. Forks mit aktiven Drafts würden Events an LU'S senden.
- `.claude/agents/finance-*.md` und `daily-coo.md`: konkrete MCP-Toolnamen `mcp__LU_S_Lexware__*`.
- `.claude/settings.json`: Deny-Liste mit LU'S-Servernamen (der Hook ist servernamen-unabhängig).

**Für Gastro-SaaS zu abstrahieren:**
- Callback-URL per Env-Variable.
- Agent-Dateien aus Templates je Kunde generieren.
- Mandantenfähige, persistente Queue statt RAM.
- Secrets pro Mandant.
- Datenablage für Rezepte, Preise und Personal außerhalb des öffentlichen Repos.
- Je Kunde ein Connector-Katalog (POS, Reservierung, Lohn).

---

## COST / RESOURCE REVIEW

- **Laufende AI-Nutzung:** nur bei Anfragen von Luigi (CEO plus Subagenten). Es gibt keine Hintergrund-Loops und keine Cron-Routinen.
- **Event-driven:** Lexware-Webhook → Queue (ohne AI-Kosten), PR-Events für CI.
- **Potentiell teuer:** tägliche Briefs oder Radar per Cron mit starkem Modell, breite Fan-outs über
  alle Boards, große PDF-Texte im Kontext.
- **Modellwahl:** Auditoren und CEO `inherit`, Specialists `sonnet`, Health-Checks `haiku`.
- **Nicht aktiviert:** kein Render-Upgrade, kein GHAS, keine SaaS-Bots, keine neuen APIs, keine Cron-Routinen.
  GitHub Actions und CodeQL sind für öffentliche Repos kostenlos.

---

## OPEN BLOCKERS

1. **Branch-Schutz fehlt.** Ruleset `ai-company/github/ruleset-main.json` importieren (Luigi).
2. **Dependency Graph aktivieren** (Luigi). Danach wird der CI-Job `dependency-review` grün.
3. **Prod-Dependency-Audit rot** (1 critical, 11 high, transitiv). Lösung über einen separaten Update-PR oder Dependabot
   Security Updates, Freigabe durch Luigi.
4. **Render nicht prüfbar:** Domain-Freigabe in der Cloud-Umgebung oder Render-Connector (nur lesend). Entscheidung bei Luigi.
5. **Entscheidung zur serverseitigen drafts-Write-Fläche** (`create-voucher`, `update-voucher`, `upload-*` sind in Produktion
   über claude.ai-Chats erreichbar). Siehe `ai-company/policies/finance-write-gates.md`.

---

## NEXT RECOMMENDED PHASE

**PHASE 2: LU'S FINANCE / LEXWARE MASTER COMPLETION.** Wird **nicht** automatisch gestartet.

Vorgeschlagener Einstieg, nachdem ChatGPT auditiert und Luigi freigegeben hat:
1. Write-Fläche serverseitig absichern (Entscheidung zu Blocker 5).
2. Webhook-Handler aus `server.ts` herauslösen und testen (Signatur, Replay, organizationId).
3. Persistente Queue.
4. Callback per Env-Variable.
5. Erst danach ein kontrolliertes, bestätigungspflichtiges Expense-Write-Modul.

---

## HANDOVER FOR CHATGPT: TECHNICAL AUDIT

(Eigenständig verständlich. Keine Credentials enthalten.)

**Kontext.** LU'S (Pinsaboys UG, Gastronomie) betreibt einen selbst gehosteten Open-Source-MCP-Server
für die Lexware-Office-API: Repo `Lus-Pinsa/lexware-mcp` (öffentlich, MIT), TypeScript/Skybridge, Deployment
auf Render als Service `lus-lexware-mcp` (`https://lus-lexware-mcp.onrender.com/mcp`). Er ist in Claude als
Connector „LU'S Lexware“ angebunden, Auth per OAuth 2.1. Phase 1 (dieser Auftrag) baute die
Multi-Agent-Foundation ohne produktive Writes.

**Zu auditieren.** PR https://github.com/Lus-Pinsa/lexware-mcp/pull/2 (Draft), Branch `claude/busy-knuth-0980fw`,
Basis `main@b601a6c`. Commits: `6ebe68d`, `163648c`, `50586f8`, `46be074`, `76573d1`, `3a69a7e`, `5f9e8df`,
dazu der Final-Report-Commit. Diff ohne Lockfile ca. 214 KB, Laufzeitcode nur in `src/oauth.ts` geändert.

**Tatsächliche Architektur.**
- Claude Code als Laufzeit der Agenten.
- Der Cloud CEO ist ein Skill (`.claude/skills/cloud-ceo/SKILL.md`), optional als Hauptsession-Agent
  (`claude --agent cloud-ceo`). Er delegiert **flach** an 16 Agenten in `.claude/agents/`.
- Organisation, Rollen, KPIs und Profile liegen maschinenlesbar in `ai-company/core/*.json`.
- `ai-company/core/governance.ts` implementiert deterministisch: `certifyStatus` (GRÜN nur mit Nachweis),
  `assertSeparationOfDuties` (wirft Fehler), `runReviewLoop` (max. 3 Fix-Runden, nicht erhöhbar, danach BLOCKED mit
  Eskalation) und `decideAction` (Phase-1-Verbote, fail-closed).
- `ai-company/core/registry.ts` validiert die Konsistenz von Org, Profilen, Agent-Dateien und Customer Config, CI erzwingt das.

**Tests.** `npm test`: 12 Dateien, 216/216 grün (lokal Node 22, CI Node 24). Davon neu:
- `tests/finance-policy.test.ts`: exakte Menge der zustandsändernden Tools in der Produktionskonfiguration,
  keine Finalize-, Delete- oder freien Webhook-Tools, READ_ONLY registriert nur readOnly-Tools,
  Reconcile und PDF-Text rufen keine Write-Methoden, Queue ist idempotent, Acknowledge ist rein lokal, Webhook-Tool mit festem Ziel.
- `tests/governance.test.ts`: Registry, Rechte, Review-Loop, Policy, Hook-Verhalten (u. a. 16 gefährliche
  und 7 erlaubte Shell-Befehle), Settings, Scanner.
- Zuvor 7 rote, veraltete Tests auf `main`, jetzt repariert.

**CI.** Die ersten Actions-Läufe der Repo-Historie: build-test ✅, secret-scan ✅, docker ✅, CodeQL ✅,
dependency-review ❌ (Dependency Graph deaktiviert), audit ❌ (transitive Advisories, Lockfile unverändert).

**Connector-Status.** GitHub VERIFIZIERT · LU'S Lexware VERIFIZIERT nur lesend (6 Read-Tools live) ·
Render BLOCKIERT (Egress-Proxy der Agent-Umgebung, kein Render-Connector).

**Render- und Lexware-Status.**
- Laut Tool-Liste des Connectors gilt: Finalize **aus**, Drafts **an**, READ_ONLY **aus**.
- Ein Webhook-Abo `voucher.created` ist aktiv.
- Queue leer (RAM), Reconciliation, PDF-Text und SHA-256 funktionieren.
- Keine Writes ausgeführt.

**Permission-Modell.**
- 11 Profile, jede Rolle genau eines.
- Reviewer ohne Edit/Write.
- Kein Profil mit Finance-, Prod- oder Deploy-Write oder Secrets.
- Finance-Agenten nur mit Lexware-Read-Tools.
- CEO ohne Schreibrechte.

**Security Gates vorhanden.**
- Settings-Deny für alle 24 Lexware-Write- und Finalize-Tools und für Merge. Live belegt: Die Tools verschwanden aus der Session.
- Guard-Hook live belegt: Push auf main und Änderungen an Gate-Dateien wurden blockiert.
- CI-Gates wie oben, CODEOWNERS, `permissions: contents: read`, serverseitige Tiers, Webhook-Signatur, PII-Fix.

**Fehlende Gates.** Ruleset/Branch-Schutz, Dependency Graph, natives Secret Scanning (nicht prüfbar),
Webhook-Unit-Tests (erfordern ein Refactoring von `server.ts`), Replay-Schutz, organizationId-Abgleich, serverseitige
Einschränkung von `create-voucher`/`update-voucher`, Pflicht-E-Mail-Allowlist bei OAuth, Untrusted-Data-Markierung,
Audit-Log außerhalb von Git.

**Bekannte Risiken.**
1. Hook und Settings wirken **nur in Claude-Code-Sessions dieses Repos**. In claude.ai-Chats mit dem Connector
   sind 15 Lexware-Write-Tools erreichbar (Drafts-Tier), darunter das Buchen von Belegen.
2. Der Hook arbeitet string-basiert, ist umgehbar (Obfuskation) und erzeugt False Positives. Er ist eine Leitplanke, keine Sandbox.
3. Läuft der CEO als Hauptsession, begrenzen ihn nur Hook, Settings und Skill, nicht seine Tool-Liste.
4. Die RAM-Queue geht bei Restart oder Spin-down verloren. Reconciliation ist der Fallback.
5. Fester LU'S-Callback in einem öffentlichen Repo.
6. Transitive Dependency-Advisories.
7. `[debug]`-Request-Log läuft immer (ohne PII).
8. Prompt Injection über Lieferanten-PDF-Text in Sessions mit Write-Tools.

**Blocker.** Siehe Abschnitt OPEN BLOCKERS (1–5), alle mit Owner-Aktion oder Owner-Entscheidung.
