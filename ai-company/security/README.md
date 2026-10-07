# Security Architecture Gate (vor Phase 2 · PR 3 Persistence)

Basis: `main` = `8f938aa`. Dieser PR enthält **keinen Persistence-Code, keine Lexware-Writes und keine Änderung der Read-only-Grenze**.
Ziel: Eine Architektur, in der ein kompromittierter Teil möglichst wenig Schaden anrichtet.
Prinzipien: Zero Trust, Least Privilege, Defense in Depth, Fail Closed, explizite Trust Boundaries, Nachvollziehbarkeit, Wiederherstellbarkeit, Datenminimierung.

## Dokumente

| Dokument | Inhalt |
|---|---|
| [`threat-model.md`](threat-model.md) | Assets, Angreifer, Trust Boundaries, STRIDE je Komponente, Angriffspfade |
| [`attack-surface-audit.md`](attack-surface-audit.md) | alle Befunde mit Schweregrad, Nachweis und Status (FIXED, OWNER, DECISION, FUTURE, ACCEPTED) |
| [`data-classification.md`](data-classification.md) | PUBLIC bis SECRET; was gespeichert, geloggt, committet, getestet, an AI gegeben und exportiert werden darf |
| [`history-exposure.md`](history-exposure.md) | Öffentliche Git-Historie: Exposure, Risiko (LOW), Cleanup-Optionen (**nichts ausgeführt**) |
| [`supply-chain-and-platform.md`](supply-chain-and-platform.md) | npm, Actions, Ruleset Soll/Ist, Repo-Einstellungen, Render, Provenance |
| [`contracts/persistence-security-contract.md`](contracts/persistence-security-contract.md) | verbindliche Anforderungen P-00 bis P-92 für PR 3 |
| [`contracts/multi-tenant-security-contract.md`](contracts/multi-tenant-security-contract.md) | Tenant-Grenzen T-01 bis T-13 |
| [`contracts/voice-messaging-security-contract.md`](contracts/voice-messaging-security-contract.md) | WhatsApp/Telefon V-01 bis V-10 („nie: telefonisches Ja → Überweisung“) |
| [`incident-response.md`](incident-response.md) | Credential-Inventar mit Wirkungsbereich; Detect, Contain, Revoke, Rotate, Recover, Audit |

## Ergebnis in einem Satz

Kein CRITICAL. **Ein HIGH (SUP-01)**: Das Ruleset erzwingt CodeQL, Audit und dependency-review nicht. Behebbar nur durch den Owner, es ist keine Architekturänderung nötig. Bis dahin ist die Posture **nicht READY**. Die kleinen Code-Befunde sind in diesem PR behoben und getestet; die übrigen sind dem Owner, einem Vertrag oder einem Folge-PR zugeordnet.

## Read-only-Nachweis

| Nachweis | Ergebnis |
|---|---|
| Live `get-server-info` (Produktion, gelesen am 2026-10-07) | Build `8f938aa` (= `main`), Tiers `["read"]`, `effectiveReadOnly: true`, 46 Tools, `writeCapable: []`, Auth `static` |
| `PRODUCTION_WRITE_TOOLS` (`tests/finance-policy.test.ts`) | byte-identisch zu `d238b74` und `8f938aa` |
| Lokaler Start mit `LEXWARE_READ_ONLY=true` | `tools/list` liefert 46 Tools, alle mit `readOnlyHint` |
| Änderungen dieses PRs an Tools | keine neuen Tools, keine Tier-Änderung; nur Größen-Cap für bestehende Read-Downloads |

## Owner Actions (priorisiert)

| # | Aktion | Bezug | Aufwand |
|---|---|---|---|
| **O-1** | **Ruleset `main-protection` auf das Soll bringen**: Pflicht-Checks `audit (production dependencies)`, `dependency-review (new dependencies in PR)` und `analyze`, jeweils mit Quelle „GitHub Actions“; „Require branches to be up to date“; „Require code scanning results“ (CodeQL, Errors, Security High or higher); Merge nur per Squash. UI: Settings → Rules → Rulesets → main-protection. JSON: `ai-company/github/ruleset-main.json`. Zusätzlich ein Tag-Ruleset (alle Tags: deletion, non_fast_forward, update). | **SUP-01 (HIGH)**, SUP-16 | 10 min |
| O-2 | Konten härten: 2FA bzw. Passkeys auf GitHub, Render, Lexware und beim IdP. Berechtigungen der Claude-GitHub-App und vorhandene PATs prüfen: nur Contents und Pull requests, **kein** Administration-Recht. | SUP-03 | 15 min |
| O-3 | Settings → Advanced Security: Dependabot Alerts und Security Updates, Private Vulnerability Reporting, Secret Scanning Non-Provider-Patterns und Validity Checks aktivieren (kostenlos für öffentliche Repos). | SUP-04, SUP-11, SUP-12 | 5 min |
| O-4 | Nach dem Merge in Render `LEXWARE_ORGANIZATION_ID` setzen (eigene Lexware-Organisations-ID; nicht im Chat oder Repo nennen). Danach prüfen: `get-server-info` → `webhook.organizationBindingConfigured: true`. | SAG-03 | 5 min |
| O-5 | Workflow-Wartung (Gate-Dateien, Maintenance-Modus): Actions per SHA pinnen (Tabelle in `supply-chain-and-platform.md`), CodeQL-Sprache `actions` ergänzen. | SUP-02, SUP-14 | 20 min |
| O-6 | `MCP_AUTH_TOKEN` prüfen: mindestens 32 zufällige Zeichen (`openssl rand -hex 32`), sonst rotieren. Nach dem Merge zeigt das Startlog eine Warnung, wenn es kürzer ist. | SAG-08 | 5 min |
| O-7 | Render-Dashboard prüfen: `LEXWARE_READ_ONLY=true` **explizit** gesetzt, `LEXWARE_ENABLE_FINALIZE=false`, Auto-Deploy nur nach grüner CI (falls angeboten), Deploy-Hooks (geheim), Team-Mitglieder, Health-Check-Pfad `/status`, Build aus dem Dockerfile. Nach jedem Deploy: `get-server-info` (Tiers `["read"]`, `writeCapable: []`, Build-SHA = `main`). | SAG-02, SUP-18 | 15 min |
| O-8 | Falls Render nicht aus dem Dockerfile baut: `SKYBRIDGE_TELEMETRY_DISABLED=1` in der Render-Env setzen. | SAG-14 | 2 min |
| O-9 | Repo-Hygiene: „Automatically delete head branches“ an, Rebase-Merge aus. Alte Branches (`patch-*`, `claude/dependency-hardening`) prüfen und selbst löschen; Agents löschen keine Branches. | SUP-15 | 5 min |
| O-10 | Lexware: einen eigenen API-Schlüssel nur für diesen Server verwenden. Prüfen, ob Lexware Schlüssel mit eingeschränkten Rechten anbietet; der heutige Schlüssel kann schreiben. | Threat Model P2/P3 | 10 min |

## Owner-Entscheidungen

| # | Entscheidung | Optionen / Empfehlung |
|---|---|---|
| D-1 | **Read-only ohne Env-Abhängigkeit** (SAG-02): Heute registriert der Server ohne `LEXWARE_READ_ONLY` die Write-Tools (Drafts standardmäßig an). | (a) Standard auf read-only umstellen (Änderung der Read-only-Grenze und des Open-Source-Verhaltens), (b) Start-Guard über eine eigene Variable, (c) so lassen und mit O-7 überwachen. **Empfehlung: (a) in einem eigenen kleinen PR.** |
| D-2 | **Git-History-Vorfall** (HIST-1) | (a) akzeptieren und dokumentieren *(Empfehlung)*, (b) Rewrite und Force-Push, (c) GitHub-Support, (d) Fork-Netzwerk verlassen, (e) privat. Details in `history-exposure.md`. |
| D-3 | **Fixture-Kalendertage** (HIST-R1) | in einem Folge-PR durch erfundene Tage ersetzen (Testmatrix anpassen, Gegenprobe). Empfehlung: ja. |
| D-4 | **Persistence-Kosten und Fristen** (Persistence-Vertrag P-00, P-60, P-70) | Render Persistent Disk oder Managed DB (kostenpflichtig) sowie Backup-Ziel; Aufbewahrungsfristen. Ohne Freigabe startet PR 3 nicht. |

## Evidence

_Wird nach den unabhängigen Reviews ergänzt._
