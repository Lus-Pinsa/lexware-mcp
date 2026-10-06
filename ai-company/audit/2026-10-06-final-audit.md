# Phase I: Final Audit (06.10.2026)

Drei unabhängige, nur lesende Prüfer liefen **parallel** auf dem PR-Head. Keiner hat die Foundation gebaut.
Alle haben die Gates selbst ausgeführt.

| Prüfer | Fenster (UTC) | Urteil | Status |
|---|---|---|---|
| I1 Security Auditor | 12:13:49–12:19:40 | **PASS WITH RISKS** | GELB |
| I2 Final Auditor (QA / Definition of Done) | 12:13:48–12:18:47 | **DONE WITH OPEN ITEMS**: 16/19 DoD-Punkte verifiziert, 3 teilweise | GELB |
| I3 Architecture Reviewer | 12:13:51–12:19:31 | **REQUEST_CHANGES als Phase-2-Backlog**: „nichts davon blockiert Foundation V1“ | GELB |

Übereinstimmende Nachweise aller drei Prüfer: `npx vitest run` 216/216, `tsc` (Server und Governance) exit 0,
Secret-Scan 0 Funde, `npm audit --omit=dev` mit 1 critical und 11 high (Lockfile unverändert). Im `src/`-Diff ist nur
`src/oauth.ts` geändert (PII-Log entfernt). Der Lexware-Read-Stack ist unverändert, Finalize bleibt aus.

## Umgesetzte Korrekturen aus dem Audit (Commit nach `96c144b`)

| Befund | Quelle | Umsetzung |
|---|---|---|
| CodeQL High `js/file-system-race` im Scanner | GitHub CodeQL | `96c144b`: Lesen über einen File-Descriptor; CodeQL danach grün |
| Retry-Limit-Test tautologisch (verglich nur mit der Konstante) | I3 | Test pinnt `MAX_FIX_ROUNDS === 3 === org.governance.maxFixRounds` |
| Reviewer ohne Agent umgingen die Trennungsprüfung | I3 | Fallback-Reviewer ist `final-auditor`; die Registry prüft dessen Unabhängigkeit. Der neue Test schlägt auf dem alten Code fehl. Der CEO-Skill begrenzt solche Boards auf GELB. |
| `cloud-ceo` lud zur Delegation als Subagent ein (dritter Modus) | I3 | Beschreibung jetzt: „main-session agent only“, im Normalfall den Skill nutzen |
| Vendor-Name im Core (`render-monitor`) | I3 | umbenannt in `hosting-monitor` |
| Falsche Aussage im Testprotokoll (216/216 nach `6ebe68d`) und missverständliche G-Startzeit | I2 | korrigiert (135/135 bei `6ebe68d`; CEO-Start vs. Agent-Start) |
| „technisch gedeckelt“ überzogen | I2 | präzisiert: im Code und in Tests gedeckelt; in Live-Sessions eine Prozessregel |
| KPI-Aussage im Katalog falsch („nur Finance messbar“) | I3 | korrigiert: 20/51 KPIs mit verbundener Quelle, Agentenzugriff nur für Finance und Engineering |
| CODEOWNERS-Versprechen vs. Ruleset mit 0 Approvals | I1/I3 | ehrlich dokumentiert (einziger Maintainer, Merge nur durch Luigi) |
| Geschäftsbezogene Details in der öffentlichen Inventur | I1 | Belegzahlen und Dubletten-Hinweis entfernt (nur im Chat an Luigi) |

## Nicht umgesetzt: Gate-Dateien (Freigabe durch Luigi nötig)

`.claude/settings.json`, `.claude/hooks/`, `.github/workflows/` und `CODEOWNERS` sind per Guard-Hook gegen
Agenten-Änderungen gesperrt. Das ist so gewollt. Die folgenden Härtungen brauchen deshalb Luigi im Wartungsmodus
(`AI_COMPANY_GATE_MAINTENANCE=1`) oder eine manuelle Änderung:

**Härtungsvorschlag für `.claude/hooks/guard.mjs` und `.claude/settings.json` (Befunde I1/I3):**
1. Den Hook-Matcher um `Monitor|Grep|Glob|Agent|WebFetch` erweitern. `Monitor` führt Shell-Befehle aus.
2. Push-Erkennung robust machen: `\bgit\b(\s+-\S+(\s+\S+)?)*\s+push\b`, damit auch `git -C … push` erkannt wird. Außerdem
   `HEAD:refs/heads/main`, Refspecs in Anführungszeichen, kombinierte Kurzflags und `gh api …/merges` abdecken.
3. Lexware-Regel von einer Denyliste auf eine **Allowliste** umstellen: Nur die Präfixe `get-|list-|reconcile-|summarize-|render-|download-`
   sind erlaubt, alles andere wird blockiert, unabhängig vom Servernamen-Muster (Fallback: jedes MCP-Tool, dessen Name Lexware-Toolnamen ähnelt).
4. Die geschützten Pfade an CODEOWNERS angleichen: `.claude/agents/`, `.claude/skills/`, `.claude/rules/`, `.mcp.json`,
   `ai-company/core/`, `ai-company/policies/`, `tests/finance-policy.test.ts`, `tests/governance.test.ts`,
   `tests/tools.test.ts`.
5. False Positives entschärfen: `2>/dev/null`, `>&2` und `=>` nicht als Schreiboperation werten.
6. Secret-Lesewege ergänzen: `gh auth token`, `/proc/*/environ`, `process.env` in `node -e`.
7. Im Settings-Deny das CEO-`Agent`-Tool auf benannte Agenten beschränken (Syntax laut Claude-Code-Doku prüfen, PoC).

## Restrisiken nach dem Audit (Kernpunkte)

1. **Server-seitige Write-Fläche (höchstes Geschäftsrisiko):** In claude.ai-Chats mit dem Connector sind 15 Lexware-Write-Tools
   erreichbar, darunter das Buchen von Belegen. Hook und Settings greifen dort nicht. Abhilfe: `LEXWARE_READ_ONLY=true`
   oder ein serverseitiger Umbau (Phase 2).
2. Der Finance-Policy-Test erkennt nur ehrlich annotierte Writes. Abgemildert, weil `tests/tools.test.ts` die
   **vollständigen Namenslisten je Tier** einfriert: Jedes neue Tool ändert diesen Test sichtbar im Review. Robust wäre ein
   auf `get`/`getBinary` beschränkter Client-Typ für Read-Registrare (Phase 2).
3. Der Guard-Hook ist umgehbar und fail-open, wenn Node fehlt oder ein Timeout greift. Die echte Grenze sind die Server-Tiers.
4. Kein aktiver Branch-Schutz. Workflows, die auf einem PR-Branch geändert werden, laufen in diesem PR.
5. Die neuen Agent-Typen wurden in dieser Session nicht technisch geladen. F/G/H belegen Prozess und Rollentreue,
   nicht die Durchsetzung der Tool-Grenzen. **Empfehlung:** F/G/H in einer neuen Session mit echtem `subagent_type` wiederholen.
6. Der Core ist nur auf JSON-Ebene kundenneutral. Agent-Dateien, Skill und Settings sind an LU'S gebunden. Für SaaS
   müssten sie aus Templates generiert werden.
7. Die Roster ist groß (124 Rollen, davon 76 ohne Agent). Die Business-Boards sind reine Struktur.

## Phase-2-Backlog aus dem Architektur-Review (priorisiert, nicht gestartet)

1. Den Server von LU'S-Spezifika lösen: Callback aus `SERVER_URL`, generischer Toolname, organizationId-Abgleich, neutrale Beschreibungen.
2. Einen einzigen CEO-Einstieg festlegen, `Agent(...)` auf registrierte Agenten beschränken, F/G/H mit echten Agent-Typen wiederholen.
3. Board-Status aus Agentenabdeckung, Reviewer und erreichbaren KPIs ableiten statt ihn zu deklarieren.
4. Validierung schärfen: technicalGate einem echten CI-Job zuordnen, KPI-Quellen gegen das Connector-Vokabular prüfen,
   capabilityTools gegen die registrierten Server-Tools prüfen, alle `customers/*` validieren.
5. Tenant-Schicht: Agenten, Settings und Skill aus `org.json` + `customer.json` generieren.
