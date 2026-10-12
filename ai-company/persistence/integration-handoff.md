# Persistence-Integration: zentraler Handoff

Dies ist die **einzige** Statusdatei für die Persistence-Integration. Sie ersetzt keine Owner-Freigabe.
Erstellt durch Claude Code am 2026-10-12, Audit und Integration ab 07:40 UTC. Stand des Dokuments: Head der Branch `claude/pg-runtime-gates` (Fix-Runde 1 und Gate-Tests, 2026-10-12).

## 1. Referenzen (verifiziert per `git fetch` und GitHub-API)

| Referenz | SHA | Status |
|---|---|---|
| `main` | `8f938aa` | unverändert seit PR #5 |
| PR #6 (Security Gate, `claude/busy-knuth-0980fw`) | `4dcb0bf` | **Abweichung zur Übergabe:** Auf `629ab31` folgt ein Doku-Checkpoint von ChatGPT (2026-10-08). Kein Code. |
| PR #33 | `7ee768f` | wie übergeben |
| PR #34 | `5729bd8` | wie übergeben. Lokal reproduziert: 47 Testdateien, **930/930** Tests (Node 22). |
| Neue PRs dieser Integration | #35 `5489356`, #36 `b0919ff`, #37 `b41ab5f` (+ Handoff `0264afe`), #38 `0cd2a46` + `e0b19b3` | Draft, gestapelt auf #34; #38 auf #37 |

Offene PRs bei Start: 27 (#6–#34 wie übergeben).

## 2. Abhängigkeiten (Git-Ancestry, nicht PR-Texte)

- **Linie A (kanonisch):** #6 → #7 → #8 → #9 → #10 → #11 → #12 → #14 → #15 → #16 → #17 → #21 → #22 → #23 → #24 → #29 → #31 → #33 → #34 → **#35 → #36 → #37**
- Von #29 abgezweigt und **nicht** in der Ancestry von #33/#34: #27 (ALL-OF), #28 (Sentinel), #30 (Zeitstempel)
  - **#28:** Inhalt per Cherry-Pick in #33 vorhanden (`limit + 1` in `integrity-repository.ts`)
  - **#27:** in #35 integriert
  - **#30:** in #36 integriert
- **Linie B:** #8 → #18 → #25 → #26. Eigene, kleinere Parallel-Implementierung mit eigenem Schema (`001_initial.sql`), eigener Bootstrap und eigener Durable Queue (30 Dateien).
  - Linie A deckt das funktional ab: fail-closed Start in `server.ts`, Migrationsstatus, Tenant-Binding, Rollenprüfung, Durable Queue aus #15.
  - **Nicht kanonisch.** Nur hier dokumentiert, nicht geschlossen.
- **#19** (Handlebars 4.7.10) basiert auf `main`. Der Override ist in Linie A bereits enthalten (in `package.json` von #34), **aber nicht auf `main`**. Siehe O-1.
- **#32** (Doku/Skills, auf #19): nicht integriert, unabhängig von der Persistence.
- Nebenbranches ohne PR: `openai/audit-append-order-v6-adr` enthält den ADR-Entwurf, übernommen in #37 als `audit-order-v7-adr.md`. Mehrere `openai/audit-*`- und `openai/*-20261011`-Branches zeigen auf PR-Heads (#28, #30, #31, #33, #34). Die Namen versprechen zum Teil Integrationen, die im Code nicht enthalten sind, z. B. `integrate-runtime-privilege-allof-20261011` = #34 **ohne** #27.

## 3. Befunde (Audit auf #34 `5729bd8`, mit echtem PostgreSQL reproduziert)

| ID | Schwere | Befund | Datei | Reproduktion | Status |
|---|---|---|---|---|---|
| E1 | **HIGH** (funktional; Persistence nicht produktiv) | Advisory-Lock-SQL aus #31 scheitert auf echtem PostgreSQL: `uuid = text`. Audit-Append, Retention und Tenant-Bootstrap funktionieren auf einer echten DB **nicht**. Die Mock-Tests schrieben den fehlerhaften String fest. | `repository.ts` (`SQL_LOCK_TENANT`) | Fixture-Bootstrap in `tests/helpers/persistence-pg-fixture.ts` | behoben in #35, technisch geprüft |
| A | MEDIUM | Pflichtrechte per Komma-Liste, also ANY-OF (#27 nicht integriert) | `repository.ts` (`SQL_RUNTIME_PRIVILEGES`) | 5 Fälle in `persistence-pg-privileges` | behoben in #35 |
| A2 | MEDIUM | Verbotene **Spaltenrechte** wurden nicht erkannt. Eine Runtime-Rolle mit `UPDATE (entry_hash) ON audit_events` wurde akzeptiert und konnte Audit-Hashes überschreiben. | dto. | 7 Fälle und ein Impact-Test | behoben in #35 |
| A3 | LOW | `TRIGGER`-Recht nicht als verboten geprüft | dto. | 3 Fälle | behoben in #35 |
| B | MEDIUM | Zeitstempel nicht kanonisiert (#30 nicht integriert). Ein einziger Append mit Offset, ohne Nachkommastellen oder mit Null-Mikrosekunden macht die Kette **dauerhaft** unverifizierbar. Ungültige Werte wurden angenommen (30.02., 24:00, +15:00, Nanosekunden). | `audit.ts` | 12 Fälle in `persistence-pg-audit-timestamps` | behoben in #36 |
| E2 | LOW | Validierungsfehler wie „Audit chain integrity check failed.“ wurden in Runtime-Transaktionen zu `TRANSACTION_FAILED` verschleiert | `postgres-driver.ts` | Unit-Test | behoben in #36 |
| C | **HIGH** (Integrität; Persistence nicht produktiv) | Die Kettenreihenfolge folgt Ereigniszeit und UUID. Gleiche Millisekunde, Rückdatierung oder 12 parallele Appends machen die Kette unverifizierbar. Ein dritter Append in derselben Millisekunde erzeugt einen **Fork**. Retention ist blockiert. | `repository.ts`, `integrity*.ts`, `maintenance-repository.ts` | 7 Fälle in `persistence-pg-audit-order` | behoben in #37 (Schema v7) |
| D1 | LOW | Retention prüfte die Löschanzahl nicht gegen die verifizierte Menge | `maintenance-repository.ts` | Unit-Test | behoben in #37 |
| D2 | INFO | „Kapazität voll, nichts löschbar“: Retention scheitert dauerhaft (fail closed, kein Datenverlust) | `retention.ts` | `persistence-pg-audit-guards` | dokumentiert, Verhalten bewiesen |
| T1 | INFO | Alle Persistence-Tests bis #34 waren Mocks. Kein PR hatte einen echten PostgreSQL-Nachweis, auch nicht #31 („ephemeral regression“ im Branchnamen). | `tests/` | — | behoben: Harness in #35 |
| S1 | **CRITICAL** (Advisory; Ausnutzbarkeit gering) | `main` enthält `handlebars` 4.7.9 als **Produktions**-Abhängigkeit (über skybridge) mit drei kritischen Advisories. `npm audit --omit=dev` meldet critical. Skybridge nutzt nur `handlebars/runtime` mit vorkompilierten Templates, aber der CI-Job `audit` wird beim nächsten Lauf auf `main` rot. | `package-lock.json` (main) | `npm audit --package-lock-only --omit=dev` | Fix in #19 (unabhängig geprüft, siehe 5). **Owner-Merge nötig.** |

### 3a. Befunde der unabhängigen Reviews von #35–#37 (Fix-Runde 1)

Code Review (Agent `code-reviewer`): **APPROVE WITH NITS**, YELLOW. Security-Audit (Agent `security-auditor`, 9 eigene Angriffssonden auf echtem PostgreSQL): **PASS WITH RISKS**, YELLOW, kein CRITICAL/HIGH. Beide liefen auf `b41ab5f` und haben den Code nicht geschrieben.

| ID | Schwere | Befund | Status |
|---|---|---|---|
| M1 | MEDIUM | Zeitstempel mit Jahr < 1000 (z. B. `0050-…`) oder historische Offsets werden angenommen, gespeichert und vom Treiber als anderer Zeitpunkt gelesen: Kette danach dauerhaft unverifizierbar | behoben in `0cd2a46`: nur 1970–9999 UTC; Treiber `TimeZone=UTC` |
| M2 | MEDIUM | CREATE auf anderen Schemata, eigenes Schema und `search_path` nicht geprüft: Schattentabelle lenkte Audit-Schreibvorgänge um, Verifikation meldete „gültig“ | behoben: `search_path=public, pg_temp` im Treiber; Rechteprüfung lehnt CREATE auf jedem Schema, Schema-Besitz, REPLICATION und REFERENCES ab |
| L1 | LOW | DB erzwingt weder Lückenlosigkeit noch Verkettung (Einfügen bei head+10 oder neue Wurzel nach Pruning möglich); ADR behauptete mehr | behoben: Migration 008, Trigger `audit_events_append_guard`; ADR korrigiert |
| L2 | LOW | Isolationslevel nicht festgelegt (Rollen-Default `repeatable read`: 5 von 8 Appends scheitern) | behoben: `read committed` beim Verbindungsaufbau |
| L3 | LOW | `CREATE UNIQUE INDEX IF NOT EXISTS` in 007 kann eine Vorbelegung still übernehmen | behoben: 008 prüft beide Indizes strukturell, sonst Abbruch |
| L4 / F1 | MEDIUM/LOW | `PERSISTENCE_REQUIRE_PG=1` war wirkungslos; CI setzt die Variable nicht | Harness behoben (bewiesen per versteckten Binaries); CI-Variable bleibt **O-2** |
| L5 | LOW | Test „v6 → v7“ migrierte tatsächlich v0 → v7 | umbenannt; echter v6→v8-Upgrade mit bestehendem Tenant ergänzt |
| F2–F4 | LOW | Harness: kein Aufräumen bei Startfehler, keine Timeouts, Root ohne `postgres`-User, Port-Race | behoben |
| F5 | LOW | REFERENCES nicht verboten | behoben (MAINTAIN erst ab PG 17, dokumentiert) |
| F6 | MEDIUM (Prozess) | Migration 007 blockiert jede DB mit Audit-Historie; keine dokumentierte Owner-Bestätigung | **Owner-Bestätigung D-1** |
| F7 | LOW | Guard-Tests prüften nur „wirft“ | behoben: SQLSTATE 23514/23505 und Constraint-Namen über Roh-Client |
| F8 | LOW | ADR nannte falsche Branch | behoben |
| F9 | NIT | tote Mock-Matcher | einer entfernt; der Restore-Matcher ist **nicht** tot (`restore-repository.ts:98`), bleibt |
| INFO | — | Superuser/Owner kann den Trigger deaktivieren; Kette > 100 000 nicht prunebar; Versionsfehler im Migrationspfad generisch; TEMP-Recht bleibt (durch `pg_temp` zuletzt entschärft, getestet) | als Restrisiko im ADR |

## 4. Nachweise je SHA

Alle lokalen Läufe: Node v22.22.0, PostgreSQL 16.15 (kurzlebige Instanz, TLS, nur Loopback), synthetische Daten.

| SHA | Befehl | Ergebnis |
|---|---|---|
| `5729bd8` (#34) | `npx vitest run` | 47 Dateien, 930/930 |
| `5489356` (#35) | `npx vitest run` | 50 Dateien, 972/972 (40 auf echtem PostgreSQL) |
| `b0919ff` (#36) | `npx vitest run` | 52 Dateien, 991/991 |
| `b41ab5f` (#37) | `npx tsc -b --force`; `npm run typecheck:governance`; `npx vitest run`; `node ai-company/scripts/secret-scan.mjs` | exit 0; exit 0; 54 Dateien, **1009/1009** (71 auf echtem PostgreSQL); 0 Funde |
| `0cd2a46` (#38, Fix-Runde 1) | `npx vitest run` ohne die drei neuen Gate-Dateien; `tsc`; Governance; Secret-Scan | 54 Dateien, **1025/1025**; exit 0; exit 0; 0 Funde |
| `e0b19b3` (#38, Gate-Tests) | `npx tsc -b --force`; `npx vitest run`; `npm run typecheck:governance`; Secret-Scan | exit 0; 57 Dateien, **1056/1056**; exit 0; 226 Dateien, 0 Funde |
| Gegenproben Fix-Runde 1 | je Fix eine Mutation | `search_path` weg: 2 rot; Jahresgrenzen (beide Schichten) weg: 1 rot; Trigger wirkungslos: 2 rot; Index-Prüfung weg: 1 rot; `read committed` weg: 1 rot; `TimeZone` weg: 1 rot; neue Rechte-Codes ignoriert: 3 rot; REFERENCES weg: 2 rot |
| Gegenproben Gates | je Gate eine Mutation | Kapazitätsprüfung weg: 1 rot; Webhook-Digest im Restore weg: 1 rot; Organisationsprüfung weg: 1 rot; `ON CONFLICT` weg: 2 rot |
| F1-Nachweis | PostgreSQL-Binaries per `unshare` und Bind-Mount versteckt | ohne Variable: 6 übersprungen und sichtbare Warnung; mit `PERSISTENCE_REQUIRE_PG=1`: FAIL |
| Gegenproben | neue Tests gegen den jeweiligen Vorher-Commit | Lock: Bootstrap scheitert. Rechte: 17 rot. Zeit: 12 rot (plus 1 Treiber). Reihenfolge: 7 von 7 rot. |
| CI #35–#37 | GitHub Actions | siehe Checks der PRs. Ob der Runner die PostgreSQL-Tests ausführt (statt sie sichtbar zu überspringen), steht im Log des Jobs `build-test`. |

## 5. Status je Bereich

✅ ja · ⏳ ausstehend · ❌ nein

| Bereich | implementiert | automatisiert getestet | PostgreSQL-real getestet | unabhängig geprüft | freigegeben | produktiv |
|---|---|---|---|---|---|---|
| Advisory Lock (E1) | ✅ #35 | ✅ | ✅ (2 Verbindungen, Rollback, Abbruch) | ✅ Runde 1 | ❌ | ❌ |
| Rechteprüfung (A/A2/A3) | ✅ #35 | ✅ | ✅ (echte Rollen je Fall) | ✅ Runde 1 (Funde M2/F5 → #38) | ❌ | ❌ |
| Rechteprüfung, Schemata/`search_path` (M2, F5) | ✅ #38 | ✅ | ✅ (Schattentabelle, eigenes Schema, REPLICATION, REFERENCES) | ⏳ Runde 2 | ❌ | ❌ |
| Zeitstempel (B) | ✅ #36 | ✅ | ✅ | ✅ Runde 1 (Fund M1 → #38) | ❌ | ❌ |
| Zeitstempel-Grenzen, Session-Pinning (M1, L2) | ✅ #38 | ✅ | ✅ (Rollen-Defaults überschrieben) | ⏳ Runde 2 | ❌ | ❌ |
| Append-Ordinal, Retention (C/D) | ✅ #37 | ✅ | ✅ (Parallelität, 100 000/100 001, Rollback) | ✅ Runde 1 (Funde L1/L3 → #38) | ❌ | ❌ |
| DB-Append-Guard, Migration 008 (L1, L3) | ✅ #38 | ✅ | ✅ (Lücke, Fork, Wurzel, Vorbelegung, 100 000 mit Trigger) | ⏳ Runde 2 | ❌ | ❌ |
| RLS/FORCE RLS, Cross-Tenant | vorhanden (#9) | ✅ | ✅ #38: 6 Angriffe (Lesen, Schreiben mit Positivkontrolle, Umbinden, RLS abschalten, SET ROLE) | ⏳ Runde 2 | ❌ | ❌ |
| Durable Queue (#15) | vorhanden | ✅ | ✅ #38: 204 erst nach Commit, Dedupe (8 parallel), Kapazität → 503 mit Rollback, DB weg → 503 ohne RAM-Fallback, Tenant-Isolation | ⏳ Runde 2 | ❌ | ❌ (kein echtes Queue-Ack) |
| Restore-Verifikation (#22) | vorhanden; Reihenfolge in #37 angepasst | ✅ | ✅ #38: `pg_dump`/`pg_restore`, 8 Fälle. Hinweis: Ein Restore ohne den neuesten Eintrag verifiziert für sich allein noch; erkannt wird er nur durch den Manifest-Vergleich. | ⏳ Runde 2 | ❌ | ❌ |
| Runtime-Verkabelung (`server.ts`, fail closed) | vorhanden (#12–#17) | ✅ | ✅ #38: 10 Startfälle mit der Startsequenz aus `server.ts` (nachgebildet, nicht der Prozess selbst) | ⏳ Runde 2 | ❌ | ❌ |
| TLS-Policy (#17) | vorhanden | Mock | Tests nutzen `require` gegen ein selbstsigniertes Zertifikat; `verify-full` nicht real getestet | ❌ | Entscheidung offen (`render-internal-tls-decision.md`) | ❌ |
| Handlebars-Fix (#19) | ✅ | CI grün auf `008fcba` | — | ✅ (Claude, unabhängig von ChatGPT) | ❌ (Owner-Merge) | ❌ |

**Governance/Boards** (`ai-company/core/org.json`):
- 19 Boards: 6 `foundation-ready`, 2 `partial` (devops, daily-coo), 11 `structure-ready`.
- 16 Agent-Definitionen.
- Eine echte Datenquelle hat nur Finance (Lexware-Read-Tools); Daily COO nutzt sie teilweise.
- Die 11 `structure-ready`-Boards haben weder Datenquelle noch ausführbaren Ablauf. Sie laufen nur über den generischen `board-analyst`.

## 6. Offene Gates (Reihenfolge)

1. **Unabhängiger Review Runde 2** von #38 (`e0b19b3`): Code Review und Security-Audit auf die Fixes und die neuen Gates. Danach höchstens zwei weitere Fix-Runden je Problem, sonst BLOCKED.
2. **CI-Nachweis** auf dem finalen SHA. Fehlt PostgreSQL auf dem Runner, werden die Tests übersprungen und gelten **nicht** als bestanden (O-2).
3. Restrisiken aus 3a (Trigger-Deaktivierung durch Superuser, MAINTAIN ab PG 17, Kette > 100 000) bewusst annehmen oder beauftragen.
4. TLS-Entscheidung (`verify-full` gegen Render intern), separat und durch den Owner.
5. Erst danach: Merge der Linie A durch den Owner. Die Reihenfolge der Stack-Merges legt der Owner fest.

## 7. Owner-Aktionen und -Entscheidungen (nur neue)

| # | Handlung | Grund | Risiko ohne | PR | Sichere Zwischenlösung |
|---|---|---|---|---|---|
| O-1 | PR #19 prüfen und mergen (Handlebars 4.7.10 per Override, nur `package.json` und Lockfile) | Kritische Advisories in einer Produktionsabhängigkeit auf `main`; der CI-Job `audit` wird rot | Advisory bleibt offen, `main`-CI rot (Ausnutzbarkeit gering: nur vorkompilierte Templates) | #19 | keine nötig; der Server bleibt read-only |
| O-2 | In `.github/workflows/ci.yml` (Gate-Datei, Maintenance-Modus) im Job `build-test` `PERSISTENCE_REQUIRE_PG=1` setzen | Ohne die Variable würden die PostgreSQL-Tests auf einem Runner ohne PostgreSQL still übersprungen | Ein grüner CI-Lauf ohne echten PostgreSQL-Nachweis | #35 | im CI-Log prüfen, dass die `persistence-pg-*`-Tests ausgeführt wurden |
| D-1 | Bestätigen, dass Persistence nie mit echten Daten aktiviert wurde (es gibt keine DB mit Audit-Zeilen). Falls doch: Umgang mit der Alt-Historie entscheiden. Das Code Review verlangt die Bestätigung vor einem Merge (F6). | Migration 007 bricht bei vorhandener Audit-Historie bewusst ab | keines (fail closed), aber Merge ohne dokumentierte Entscheidung | #37 | keine Persistence-DB anlegen, bevor D-1 entschieden ist |

Bereits früher gemeldete und unveränderte Punkte werden hier nicht wiederholt, z. B. SUP-01 (Ruleset) und SAG-02 (Read-only-Standard) aus PR #6.

## 8. Nächste Review-Aufträge

- **Runde 2, Code Reviewer:** #38 `0cd2a46` + `e0b19b3`: Fixes gegen die Befunde aus 3a, Testintegrität der neuen Gate-Suites, Migration 008
- **Runde 2, Security/Adversarial:** Umgehung von Trigger und `search_path`, Restore-Lücken, Cross-Tenant, Queue-Rennen
