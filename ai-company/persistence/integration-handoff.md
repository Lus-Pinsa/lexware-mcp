# Persistence-Integration: zentraler Handoff

Dies ist die **einzige** Statusdatei für die Persistence-Integration. Sie ersetzt keine Owner-Freigabe.
Erstellt durch Claude Code am 2026-10-12, Audit und Integration ab 07:40 UTC. Stand des Dokuments: Head der Branch `claude/audit-append-ordinal`.

## 1. Referenzen (verifiziert per `git fetch` und GitHub-API)

| Referenz | SHA | Status |
|---|---|---|
| `main` | `8f938aa` | unverändert seit PR #5 |
| PR #6 (Security Gate, `claude/busy-knuth-0980fw`) | `4dcb0bf` | **Abweichung zur Übergabe:** Auf `629ab31` folgt ein Doku-Checkpoint von ChatGPT (2026-10-08). Kein Code. |
| PR #33 | `7ee768f` | wie übergeben |
| PR #34 | `5729bd8` | wie übergeben. Lokal reproduziert: 47 Testdateien, **930/930** Tests (Node 22). |
| Neue PRs dieser Integration | #35 `5489356`, #36 `b0919ff`, #37 `b41ab5f` | Draft, gestapelt auf #34 |

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

## 4. Nachweise je SHA

Alle lokalen Läufe: Node v22.22.0, PostgreSQL 16.15 (kurzlebige Instanz, TLS, nur Loopback), synthetische Daten.

| SHA | Befehl | Ergebnis |
|---|---|---|
| `5729bd8` (#34) | `npx vitest run` | 47 Dateien, 930/930 |
| `5489356` (#35) | `npx vitest run` | 50 Dateien, 972/972 (40 auf echtem PostgreSQL) |
| `b0919ff` (#36) | `npx vitest run` | 52 Dateien, 991/991 |
| `b41ab5f` (#37) | `npx tsc -b --force`; `npm run typecheck:governance`; `npx vitest run`; `node ai-company/scripts/secret-scan.mjs` | exit 0; exit 0; 54 Dateien, **1009/1009** (71 auf echtem PostgreSQL); 0 Funde |
| Gegenproben | neue Tests gegen den jeweiligen Vorher-Commit | Lock: Bootstrap scheitert. Rechte: 17 rot. Zeit: 12 rot (plus 1 Treiber). Reihenfolge: 7 von 7 rot. |
| CI #35–#37 | GitHub Actions | siehe Checks der PRs. Ob der Runner die PostgreSQL-Tests ausführt (statt sie sichtbar zu überspringen), steht im Log des Jobs `build-test`. |

## 5. Status je Bereich

✅ ja · ⏳ ausstehend · ❌ nein

| Bereich | implementiert | automatisiert getestet | PostgreSQL-real getestet | unabhängig geprüft | freigegeben | produktiv |
|---|---|---|---|---|---|---|
| Advisory Lock (E1) | ✅ #35 | ✅ | ✅ (2 Verbindungen, Rollback, Abbruch) | ⏳ | ❌ | ❌ |
| Rechteprüfung (A/A2/A3) | ✅ #35 | ✅ | ✅ (echte Rollen je Fall) | ⏳ | ❌ | ❌ |
| Zeitstempel (B) | ✅ #36 | ✅ | ✅ | ⏳ | ❌ | ❌ |
| Append-Ordinal, Retention (C/D) | ✅ #37 | ✅ | ✅ (Parallelität, 100 000/100 001, Rollback) | ⏳ | ❌ | ❌ |
| RLS/FORCE RLS, Cross-Tenant | vorhanden (#9) | Mock | ⚠️ indirekt: alle Tests laufen tenant-gebunden unter FORCE RLS. Kein expliziter Cross-Tenant-Angriffstest. | ⏳ | ❌ | ❌ |
| Durable Queue (#15) | vorhanden | Mock | ❌ **offen** | ❌ | ❌ | ❌ |
| Restore-Verifikation (#22) | vorhanden; Reihenfolge in #37 angepasst | Mock | ❌ **offen** | ❌ | ❌ | ❌ |
| Runtime-Verkabelung (`server.ts`, fail closed) | vorhanden (#12–#17) | Mock | ❌ **offen** | ❌ | ❌ | ❌ |
| TLS-Policy (#17) | vorhanden | Mock | Tests nutzen `require` gegen ein selbstsigniertes Zertifikat; `verify-full` nicht real getestet | ❌ | Entscheidung offen (`render-internal-tls-decision.md`) | ❌ |
| Handlebars-Fix (#19) | ✅ | CI grün auf `008fcba` | — | ✅ (Claude, unabhängig von ChatGPT) | ❌ (Owner-Merge) | ❌ |

**Governance/Boards** (`ai-company/core/org.json`):
- 19 Boards: 6 `foundation-ready`, 2 `partial` (devops, daily-coo), 11 `structure-ready`.
- 16 Agent-Definitionen.
- Eine echte Datenquelle hat nur Finance (Lexware-Read-Tools); Daily COO nutzt sie teilweise.
- Die 11 `structure-ready`-Boards haben weder Datenquelle noch ausführbaren Ablauf. Sie laufen nur über den generischen `board-analyst`.

## 6. Offene Gates (Reihenfolge)

1. **Unabhängiger Review** von #35–#37: Code Review und Security/Adversarial laufen. Ergebnisse werden als PR-Kommentar ergänzt.
2. **CI-Nachweis** auf dem finalen SHA. Wenn PostgreSQL auf dem Runner fehlt, werden die Tests übersprungen und gelten **nicht** als bestanden (O-2).
3. **Echte PostgreSQL-Tests** für Durable Queue (Dedupe, Commit vor 204, Kapazität, kein RAM-Fallback), Restore (Dump/Restore und Integrität danach), Runtime-Start (fail closed bei falscher Rolle, Migration oder Tenant-Bindung) und einen expliziten Cross-Tenant-Angriff.
4. TLS-Entscheidung (`verify-full` gegen Render intern), separat und durch den Owner.
5. Erst danach: Merge der Linie A durch den Owner. Die Reihenfolge der Stack-Merges legt der Owner fest.

## 7. Owner-Aktionen und -Entscheidungen (nur neue)

| # | Handlung | Grund | Risiko ohne | PR | Sichere Zwischenlösung |
|---|---|---|---|---|---|
| O-1 | PR #19 prüfen und mergen (Handlebars 4.7.10 per Override, nur `package.json` und Lockfile) | Kritische Advisories in einer Produktionsabhängigkeit auf `main`; der CI-Job `audit` wird rot | Advisory bleibt offen, `main`-CI rot (Ausnutzbarkeit gering: nur vorkompilierte Templates) | #19 | keine nötig; der Server bleibt read-only |
| O-2 | In `.github/workflows/ci.yml` (Gate-Datei, Maintenance-Modus) im Job `build-test` `PERSISTENCE_REQUIRE_PG=1` setzen | Ohne die Variable würden die PostgreSQL-Tests auf einem Runner ohne PostgreSQL still übersprungen | Ein grüner CI-Lauf ohne echten PostgreSQL-Nachweis | #35 | im CI-Log prüfen, dass die `persistence-pg-*`-Tests ausgeführt wurden |
| D-1 | Umgang mit bestehender Audit-Historie, **nur** falls irgendwo schon eine Persistence-DB mit Audit-Zeilen existiert | Migration 007 bricht dort bewusst ab | keines (fail closed) | #37 | keine Persistence-DB anlegen, bevor #37 entschieden ist |

Bereits früher gemeldete und unveränderte Punkte werden hier nicht wiederholt, z. B. SUP-01 (Ruleset) und SAG-02 (Read-only-Standard) aus PR #6.

## 8. Nächste Review-Aufträge

- **Code Reviewer:** #35–#37 einzeln (Korrektheit, Testintegrität, Übernahme von #27/#30/#28/#31)
- **Security/Adversarial:** Fork-, Lock- und Retention-Rennen, verbleibende Rechte (Default-Privileges, `pg_write_all_data`), Migration 007 mit nur einem Anker
- **QA:** Mutationstests auf Ordinal, Retention und Rechte-SQL
