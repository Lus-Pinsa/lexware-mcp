# Persistence-Integration: zentraler Handoff

Dies ist die **einzige** Statusdatei für die Persistence-Integration. Sie ersetzt keine Owner-Freigabe.
Erstellt durch Claude Code am 2026-10-12, Audit und Integration ab 07:40 UTC. Stand des Dokuments: Head der Branch `claude/pg-runtime-gates` (Fix-Runden 1–3, Verifikation Runde 4, 2026-10-12). Automatische Fix-Runden für die Persistence-Befunde sind **abgeschlossen**; offene Punkte sind Owner-Entscheidungen.

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

### 3b. Befunde Review Runde 2 auf #38 (`6afca6e`) und Fix-Runde 2

Code Review: **REQUEST CHANGES** (klein, scoped), YELLOW. Alle Fixes aus Runde 1 sind bestätigt, keine Regression gefunden. Security-Audit: **PASS WITH RISKS**, YELLOW, kein CRITICAL/HIGH. Beide liefen in neuen Instanzen, die den Code nicht geschrieben haben.

| ID | Schwere | Befund | Status |
|---|---|---|---|
| S2-F1 / C2-3 | MEDIUM | Eine falsch eingerichtete Runtime-Rolle umgeht den Guard (SET-Recht auf `session_replication_role`, Besitz der Guard-Funktion, Default-Privileges); Start prüft Trigger, RLS und Policies nicht | behoben: Migration 009 (`ENABLE ALWAYS`), Startprüfung `schema-safety-repository.ts` und erweiterte Rechteprüfung (`PARAMETER_PRIVILEGE`, `OBJECT_OWNER`, `DEFAULT_PRIVILEGES`) |
| S2-F2 | MEDIUM | Die Runtime kann für ihre eigene Rolle DateStyle und `bytea_output` ändern; der Treiber liest Zeitstempel bzw. Chiffretexte danach falsch | behoben: DateStyle, IntervalStyle, `bytea_output` und `extra_float_digits` gepinnt; Start prüft alle gepinnten Werte |
| S2-F3 / C2-1 | LOW / MEDIUM-LOW | Query-Parameter in der DB-URL überschreiben die gepinnten Settings | behoben: abgelehnt (außer den entfernten SSL-Hinweisen) |
| S2-F4 | MEDIUM | Das Restore-Manifest erfasst weder Limits, alle Queue-Spalten, die Anker-Position noch die Schutzobjekte | behoben: Manifest v2 und Schema-Prüfung auf beiden Seiten |
| S2-F5 | LOW (by design) | Ein korrekt verketteter Eintrag mit falschem Hash vergiftet die Kette; das Hashing ist ohne Schlüssel | **Owner-Entscheidung D-2** |
| C2-2 | MEDIUM (Testintegrität) | Der 204-Test bewies nicht, dass der Commit vor der Antwort liegt | behoben: Statusfolge und Zeitpunkt werden geprüft; die Mutation „204 vor enqueue“ wird jetzt erkannt |
| C2-4 | LOW | Die Prüfung des Vorgänger-Index in 008 war ungetestet | behoben |
| C2-5 | LOW | Falsch-positiv bei eigenem Temp-Schema | behoben (auch beim Objektbesitz) |
| C2-6 | NIT | Bloße `toThrow()`-Prüfungen | RLS-Angriff jetzt mit 42501, Guard mit Meldung; Restore ohne Anker mit Meldung |
| C2-7 | INFO | Ein Data-only-Restore scheitert (fail closed) | ADR Punkt 10: nur vollständiger Restore |
| S2-F6, C2-8/9 | INFO | Sitzungsweite `set_config` ist im App-Pfad nicht genutzt; CI-Variable fehlt (O-2); Start prüft Trigger und Indizes (jetzt behoben) | dokumentiert |

### 3c. Befunde Review Runde 3 auf #38 (`91a3d04`) und Fix-Runde 3 (letzte zulässige Runde)

**Code Review:** **APPROVE WITH NITS**, YELLOW. Es gab keine Defekte; YELLOW nur wegen nicht prüfbarer Punkte (PG 15/17, Managed-PostgreSQL). Der Reviewer hat zusätzlich das echte `dist/server.js` gegen einen Cluster gestartet:
- korrekt eingerichtet: Start ok, `persistence=postgres`
- Guard auf `ENABLE` (O): Abbruch mit APPEND_GUARD
- URL-Parameter: Abbruch
- Persistence aus: unverändert

Damit ist der Aufrufpfad in `server.ts` nachgewiesen.

**Security-Audit:** **FAIL** wegen eines blockierenden Befunds, YELLOW, kein CRITICAL/HIGH.

| ID | Schwere | Befund | Status |
|---|---|---|---|
| S3-F1 / C3-F2 | MEDIUM, **blockierend** | Die Schema-Prüfung fand den Guard nur über den Namen. Ersetzter Funktionsrumpf, Trigger als BEFORE UPDATE, ein zweiter BEFORE-Trigger (verschiebt `chain_seq`), Rule, Vererbungs-Kind oder UNLOGGED gingen bei Start und Restore durch. Das ist nur dem Owner, einem Superuser oder per manipuliertem Dump möglich. | behoben in Fix-Runde 3: tgtype, WHEN, Argumente, Funktionsrumpf (SHA-256 aus Migration 008), Sprache, `proconfig`, keine weiteren Trigger, keine Rules, keine Vererbung, `relpersistence` |
| S3-F2 | LOW | Die Runtime kann eigene Rollen-Defaults für nicht gepinnte Settings setzen (`synchronous_commit=off` hebelt „204 erst nach dauerhaftem Commit“ aus) | behoben: `synchronous_commit`, `standard_conforming_strings`, `row_security` gepinnt und geprüft |
| S3-F3 | LOW/MEDIUM | Eine ausführbare SECURITY-DEFINER-Funktion des Owners kann Audit-Zeilen ändern | behoben: `SECURITY_DEFINER_FUNCTION` |
| S3-F4 | LOW | Mikrosekunden-Änderungen an Zeitstempeln wurden vom Restore-Manifest nicht erkannt | behoben: Epoch mit Mikrosekunden im Fingerprint bzw. Audit-Digest |
| C3-F1 | LOW | `session_replication_role` wurde nicht geprüft (Superuser-Rollen-Default `replica` schaltet FK-Trigger ab) | behoben: Start verlangt `origin` |
| C3-F3, C3-F4 | LOW/NIT (Testlücken) | `auditAnchorSeq` und der ALTER-SYSTEM-Zweig waren ungetestet (Mutationen überlebten) | behoben |
| C3-F6 | NIT | Domänen-String noch `v1` | auf `v2` |
| S3-F5, C3-F5, C3-F7 | INFO | Metadaten-Zeitstempel, PUBLIC-Default-ACL, `work_mem`-an-PUBLIC als mögliches Falsch-Positiv, Stacktrace beim Startabbruch, Spalten-UPDATE nicht zulässig | im ADR als Restrisiko |

### 3d. Verifikation Runde 4 auf #38 (`c7b6fed`)

| Review | Ergebnis | Blockierend? |
|---|---|---|
| Code Review | **APPROVE** (Nits nicht blockierend), YELLOW nur wegen PG 15/17 und Managed-PostgreSQL. Echter Start von `dist/server.js`: korrekt eingerichtet ok; geänderte `proconfig`, Trigger-Argument, `session_replication_role=replica`, Zusatz-Trigger und ausführbare SECURITY-DEFINER-Funktion → jeweils Exit 1. Keine Falsch-Positiven nach `pg_dump`/`pg_restore` in vier Varianten und mit allen 47 Contrib-Extensions. | nein |
| Security-Audit | **PASS WITH RISKS**, YELLOW. S3-F1 ist geschlossen; alle Manipulationen aus Runde 3 und rund 20 neue Owner-Angriffe werden erkannt oder sind nur als Superuser möglich. | nein |

Offene, nicht blockierende Punkte (keine weitere automatische Runde, Grenze 3 erreicht):

| ID | Schwere | Punkt | Einordnung |
|---|---|---|---|
| R4-F1 | MEDIUM | Ein böswilliger Tabellen-Owner kann eine SECURITY-DEFINER-Funktion in ein Aggregat verpacken; die Runtime kann sie dann indirekt ausführen (z. B. Guard aus- und wieder einschalten) | Owner-Vertrauen → **D-3** |
| R4-F2 | MEDIUM (schon vorher vorhanden) | Ein böswilliger Owner kann der Runtime über eine View UPDATE/DELETE auf Audit-Zeilen geben | Owner-Vertrauen → **D-3** |
| R4-F3 | LOW | Session-Settings werden einmal beim Start auf einer Verbindung geprüft; ein Transaktions-Pooler (pgbouncer) ist nicht abgedeckt | Betriebsvorgabe: keinen Transaktions-Pooler verwenden, sonst Prüfung pro Verbindung nachrüsten |
| C4-1 | LOW (Testlücke) | `proconfig`, `tgnargs`/`tgattr` und `lanname` sind nicht durch Tests abgesichert (end-to-end vom Reviewer nachgewiesen); `assertEpochText` ohne Negativtest | optionaler Folgeauftrag |
| R4-F4/C4-4 | INFO | Keine `.gitattributes`; ein CRLF-Checkout ändert die Migrations-Checksummen (fail closed) | optional `*.sql text eol=lf` (kein Gate-File) |
| R4-F6/C4-3 | INFO | Die SECURITY-DEFINER-Prüfung berücksichtigt keine Schema-USAGE; mögliche Falsch-Positive bei Managed-PostgreSQL (fail closed) | vor Produktion die Abfrage aus dem Review auf der Ziel-DB ausführen |
| C4-5 | INFO | Ein künftiges Redefinieren des Guards muss die Hash-Quelle (Migration 008) mitziehen | im ADR vermerken, sobald relevant |

### 3e. Unabhängiger Cross-Model-Review (Codex) auf #38 `c56db5f` und Fix-Runde C (Branch `claude/persistence-c01-c03-c07`)

Prüfer: Codex (OpenAI, schreibgeschützt, andere Modellfamilie als der Ersteller). Owner-Auftrag: zuerst C-01, C-03 und C-07; höchstens drei Fix-/Review-Runden.

| ID | Schwere | Befund | Fix (diese Runde) | Regressionstest |
|---|---|---|---|---|
| C-01 | MEDIUM | RLS vertraut nur dem frei setzbaren `app.tenant_id`. Wer die Runtime-Zugangsdaten hat, kann sich auf jeden Tenant umbinden. **Korrektur:** Der Cross-Tenant-Test aus Runde 2 belegte nur, dass A unsichtbar ist, solange B gebunden ist; dass B unerreichbar bleibt, belegte er nicht. | Migration 010: Die Tabelle `tenant_runtime_bindings` legt fest, welche Rolle welchen Tenant bearbeiten darf; nur der Owner pflegt sie. Dazu kommt je Tenant-Tabelle eine RESTRICTIVE-Policy mit `tenant_runtime_allowed(tenant_id)`. Eine Rolle ohne Bindung sieht nichts. Der Start verlangt, dass die Runtime-Rolle genau an den konfigurierten Tenant gebunden ist. Die Schema-Prüfung pinnt Policies, Funktion (Rumpf-Hash aus Migration 010, SECURITY INVOKER, keine Überladung) und Bindungstabelle. Laut Rechteprüfung darf die Runtime Bindungen lesen, aber nie ändern. Operator-Pfad `bindRuntimeRoleToTenant` mit Audit-Eintrag | `persistence-pg-runtime-startup`: Rolle nur an A gebunden, setzt `app.tenant_id = B` → Lesen leer, INSERT 42501, UPDATE wirkungslos, Selbstbindung 42501. Start mit 0, 2 oder einer fremden Bindung → Abbruch. 9 Schema-Manipulationen → Abbruch. 4 Rechtefälle → Abbruch |
| C-03 | MEDIUM | Die Restore-Prüfung war tenant-bezogen. Gelöschte, geänderte oder zusätzliche andere Tenants bestanden sie | `verifyRestoredDatabaseComplete` mit Manifest v3: Tenant-Menge, Bindungen, Gesamtzeilenzahlen je Tabelle und das Manifest jedes Tenants. Das geht nur mit einer lesenden Prüfrolle mit BYPASSRLS, sonst Abbruch. `persistence:verify-restore` nutzt jetzt diesen Modus | `persistence-pg-restore`: 6 Manipulationen (Tenant gelöscht, zusätzlich, Organisation geändert, Audit von B geändert, Bindung entfernt bzw. hinzugefügt). Die alte tenant-bezogene Prüfung besteht jeweils, die neue schlägt fehl. Rolle ohne BYPASSRLS → Abbruch |
| C-07 | LOW | Der Starttest bildete `server.ts` nach | `runPersistenceStartupGates` in `src/persistence/startup-gates.ts` wird von `server.ts` **und** den Tests genutzt | `persistence-startup-gates` (lokal, ohne DB): Reihenfolge, Abbruch je Gate, `server.ts` ruft die Funktion vor dem Store-Aufbau auf und enthält keine eigene Kopie. Mutationsprobe „Schema-Gate entfernt“: 4 rot |
| C-08 | INFO | Die Testinstanz läuft mit `fsync=off`. **Korrektur:** Der Queue-Test belegt die Commit-Reihenfolge und die Sichtbarkeit über Verbindungen hinweg, **nicht** die Dauerhaftigkeit nach einem Absturz. „Dauerhafter Commit“ ist keine getestete Eigenschaft | nur Doku | — |
| C-02, C-04, C-05, C-06 | MEDIUM/LOW | entsprechen D-2, D-3, O-2 und R4-F3 | unverändert offen (Owner-Entscheidungen) | — |

Betriebsfolge nach Migration 010, in dieser Reihenfolge:
1. `GRANT SELECT ON public.tenant_runtime_bindings TO <runtime-rolle>`. Nur SELECT; jedes Schreib- oder Spaltenrecht bricht den Start ab.
2. Die Runtime-Rolle über den Operator-Pfad `bindRuntimeRoleToTenant` an genau den konfigurierten Tenant binden. Das erzeugt einen Audit-Eintrag.
3. Starten. Fehlt Schritt 1 oder 2, startet die Persistence nicht (fail closed). Für Restore-Drills braucht es eine eigene lesende Prüfrolle mit BYPASSRLS (siehe `backup-restore-runbook.md`).

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
| Fix-Runde 2 (Arbeitsstand vor Commit) | `npx tsc -b --force`; `npx vitest run`; Governance; Secret-Scan | exit 0; 57 Dateien, **1089/1089**; exit 0; 0 Funde |
| Gegenproben Fix-Runde 2 | 12 Mutationen | alle erkannt (zwischen 1 und 9 rote Tests je Mutation), darunter die beiden, die Runde 2 überlebt hatten: „204 vor enqueue“ (3 rot) und „Vorgänger-Index-Prüfung weg“ (1 rot). **Nicht** durch einen Test abgedeckt: der Aufruf in `src/server.ts` selbst; die Startsequenz wird im Test nachgebildet, nicht als Prozess gestartet. |
| Fix-Runde 3 (Arbeitsstand vor Commit) | `npx tsc -b --force`; `npx vitest run`; Governance; Secret-Scan | exit 0; 57 Dateien, **1109/1109**; exit 0; 0 Funde |
| Gegenproben Fix-Runde 3 | 14 Mutationen | alle erkannt (je 1–3 rote Tests): tgtype, WHEN, Rumpf-Hash, weitere Trigger, Rules, Vererbung, UNLOGGED, SECURITY DEFINER, `session_replication_role`, `received_at`-Epoch, Audit-Epoch, `synchronous_commit`, `auditAnchorSeq`, ALTER-SYSTEM-Zweig |
| `server.ts`-Aufrufpfad | Code-Reviewer Runde 3: echtes `dist/server.js` gegen einen ephemeren Cluster | Start ok; Guard nicht ALWAYS → Exit 1 (APPEND_GUARD); URL-Parameter → Exit 1; Persistence aus unverändert |
| CI `6afca6e` | GitHub-Runner (ubuntu-latest, kein Root) | 57 Dateien, 1056/1056; die PostgreSQL-Suites, auch `pg_dump`/`pg_restore`, liefen tatsächlich (Log des Jobs `build-test`) |
| `c7b6fed` (#38, Fix-Runde 3) | lokal und CI (GitHub-Runner) | lokal: 57 Dateien, **1109/1109**, tsc/Governance/Secret-Scan sauber. CI: 7/7 grün; `build-test` 57 Dateien, 1109/1109, PostgreSQL-Suites inkl. 22 Restore-Fälle tatsächlich ausgeführt |
| Gegenproben | neue Tests gegen den jeweiligen Vorher-Commit | Lock: Bootstrap scheitert. Rechte: 17 rot. Zeit: 12 rot (plus 1 Treiber). Reihenfolge: 7 von 7 rot. |
| CI #35–#37 | GitHub Actions | siehe Checks der PRs. Ob der Runner die PostgreSQL-Tests ausführt (statt sie sichtbar zu überspringen), steht im Log des Jobs `build-test`. |

## 5. Status je Bereich

✅ ja · ⏳ ausstehend · ❌ nein

| Bereich | implementiert | automatisiert getestet | PostgreSQL-real getestet | unabhängig geprüft | freigegeben | produktiv |
|---|---|---|---|---|---|---|
| Advisory Lock (E1) | ✅ #35 | ✅ | ✅ (2 Verbindungen, Rollback, Abbruch) | ✅ Runde 1 | ❌ | ❌ |
| Rechteprüfung (A/A2/A3) | ✅ #35 | ✅ | ✅ (echte Rollen je Fall) | ✅ Runde 1 (Funde M2/F5 → #38) | ❌ | ❌ |
| Rechteprüfung, Schemata/`search_path` (M2, F5) | ✅ #38 | ✅ | ✅ (Schattentabelle, eigenes Schema, REPLICATION, REFERENCES) | ✅ Runden 2–4 (letzte: APPROVE / PASS WITH RISKS) | ❌ | ❌ |
| Zeitstempel (B) | ✅ #36 | ✅ | ✅ | ✅ Runde 1 (Fund M1 → #38) | ❌ | ❌ |
| Zeitstempel-Grenzen, Session-Pinning (M1, L2) | ✅ #38 | ✅ | ✅ (Rollen-Defaults überschrieben) | ✅ Runden 2–4 (letzte: APPROVE / PASS WITH RISKS) | ❌ | ❌ |
| Append-Ordinal, Retention (C/D) | ✅ #37 | ✅ | ✅ (Parallelität, 100 000/100 001, Rollback) | ✅ Runde 1 (Funde L1/L3 → #38) | ❌ | ❌ |
| DB-Append-Guard, Migration 008 (L1, L3) | ✅ #38 | ✅ | ✅ (Lücke, Fork, Wurzel, Vorbelegung, 100 000 mit Trigger) | ✅ Runden 2–4 (letzte: APPROVE / PASS WITH RISKS) | ❌ | ❌ |
| RLS/FORCE RLS, Cross-Tenant | vorhanden (#9) | ✅ | ✅ #38: 6 Angriffe (Lesen, Schreiben mit Positivkontrolle, Umbinden, RLS abschalten, SET ROLE) | ✅ Runden 2–4 (letzte: APPROVE / PASS WITH RISKS) | ❌ | ❌ |
| Durable Queue (#15) | vorhanden | ✅ | ✅ #38: 204 erst nach Commit (Reihenfolge seit Fix-Runde 2 bewiesen), Dedupe (8 parallel), Kapazität → 503 mit Rollback, DB weg → 503 ohne RAM-Fallback, Tenant-Isolation | ⏳ Runde 2 | ❌ | ❌ (kein echtes Queue-Ack) |
| Restore-Verifikation (#22) | vorhanden; Reihenfolge in #37 angepasst; Manifest v2 in #38 | ✅ | ✅ #38: `pg_dump`/`pg_restore`, 17 Fälle. Hinweis: Ein Restore ohne den neuesten Eintrag verifiziert für sich allein noch; erkannt wird er nur durch den Manifest-Vergleich. | ✅ Runden 2–4 (letzte: APPROVE / PASS WITH RISKS) | ❌ | ❌ |
| Runtime-Verkabelung (`server.ts`, fail closed) | vorhanden (#12–#17); Schema- und Session-Prüfung in #38 ergänzt | ✅ | ✅ #38: 22 Startfälle mit der Startsequenz aus `server.ts` (nachgebildet, nicht der Prozess selbst) | ✅ Runden 2–4; Aufrufpfad end-to-end vom Reviewer gestartet | ❌ | ❌ |
| TLS-Policy (#17) | vorhanden | Mock | Tests nutzen `require` gegen ein selbstsigniertes Zertifikat; `verify-full` nicht real getestet | ❌ | Entscheidung offen (`render-internal-tls-decision.md`) | ❌ |
| Handlebars-Fix (#19) | ✅ | CI grün auf `008fcba` | — | ✅ (Claude, unabhängig von ChatGPT) | ❌ (Owner-Merge) | ❌ |

**Governance/Boards** (`ai-company/core/org.json`):
- 19 Boards: 6 `foundation-ready`, 2 `partial` (devops, daily-coo), 11 `structure-ready`.
- 16 Agent-Definitionen.
- Eine echte Datenquelle hat nur Finance (Lexware-Read-Tools); Daily COO nutzt sie teilweise.
- Die 11 `structure-ready`-Boards haben weder Datenquelle noch ausführbaren Ablauf. Sie laufen nur über den generischen `board-analyst`.

## 6. Offene Gates (Reihenfolge)

1. Owner-Entscheidungen **D-1, D-2, D-3** (Abschnitt 7).
2. **O-2**: `PERSISTENCE_REQUIRE_PG=1` in CI. Bis dahin ist bei jedem Lauf im Log `build-test` zu prüfen, dass die `persistence-pg-*`-Suites gelaufen sind (bisher bei allen Läufen der Fall).
3. Vor einer Produktion (separat, nicht Teil dieses Audits): die Ziel-DB (Render) auf Falsch-Positive prüfen (SECURITY-DEFINER-Abfrage, PostgreSQL-Version ≥ 15, kein Transaktions-Pooler); TLS `verify-full` entscheiden.
4. Erst danach: Merge der Linie A (#6 … #34, #35–#38) durch den Owner. Die Reihenfolge legt der Owner fest. Ich merge nichts.

## 7. Owner-Aktionen und -Entscheidungen (nur neue)

| # | Handlung | Grund | Risiko ohne | PR | Sichere Zwischenlösung |
|---|---|---|---|---|---|
| O-1 | PR #19 prüfen und mergen (Handlebars 4.7.10 per Override, nur `package.json` und Lockfile) | Kritische Advisories in einer Produktionsabhängigkeit auf `main`; der CI-Job `audit` wird rot | Advisory bleibt offen, `main`-CI rot (Ausnutzbarkeit gering: nur vorkompilierte Templates) | #19 | keine nötig; der Server bleibt read-only |
| O-2 | In `.github/workflows/ci.yml` (Gate-Datei, Maintenance-Modus) im Job `build-test` `PERSISTENCE_REQUIRE_PG=1` setzen | Ohne die Variable würden die PostgreSQL-Tests auf einem Runner ohne PostgreSQL still übersprungen | Ein grüner CI-Lauf ohne echten PostgreSQL-Nachweis | #35 | im CI-Log prüfen, dass die `persistence-pg-*`-Tests ausgeführt wurden |
| D-1 | Bestätigen, dass Persistence nie mit echten Daten aktiviert wurde (es gibt keine DB mit Audit-Zeilen). Falls doch: Umgang mit der Alt-Historie entscheiden. Das Code Review verlangt die Bestätigung vor einem Merge (F6). | Migration 007 bricht bei vorhandener Audit-Historie bewusst ab | keines (fail closed), aber Merge ohne dokumentierte Entscheidung | #37 | keine Persistence-DB anlegen, bevor D-1 entschieden ist |

| D-2 | Wie soll Hash-Fälschung durch Inhaber der Runtime-Zugangsdaten behandelt werden? Optionen: (a) akzeptieren und nur erkennen (Ist-Stand), (b) Hash im Trigger nachrechnen, (c) HMAC mit einem Schlüssel außerhalb der DB, (d) nach einer fehlgeschlagenen Verifikation auf read-only schalten | Security-Review Runde 2, F5: Wer die Runtime-Zugangsdaten hat, kann Einträge fälschen oder die Kette vergiften | Fälschung durch Insider bleibt möglich; Erkennung funktioniert (außer bei korrekt berechneten Fälschungen) | #38 | Runtime-Zugangsdaten nur dem Dienst geben; Persistence bleibt aus |

| D-3 | Gilt der Tabellen-Owner (Migrationsrolle) als vertrauenswürdig? Wenn **ja**: R4-F1/R4-F2 und nicht geprüfte CHECK-/FK-Constraints bleiben dokumentiertes Restrisiko. Wenn **nein**: Folgeauftrag „Owner-Härtung“ (alle SECURITY-DEFINER-Funktionen und Aggregate verbieten, Rechte der Runtime auf alle Relationen prüfen, Constraints vergleichen) | Review Runde 4: beide Wege setzen bewusste Manipulation durch den Owner voraus | Ein böswilliger Owner kann Audit-Zeilen ändern; die Kettenprüfung erkennt das danach | #38 | Migrationsrolle getrennt von der Runtime halten; Zugangsdaten nur dem Deploy-Prozess geben |

Bereits früher gemeldete und unveränderte Punkte werden hier nicht wiederholt, z. B. SUP-01 (Ruleset) und SAG-02 (Read-only-Standard) aus PR #6.

## 8. Nächste Aufträge (nur nach Owner-Entscheidung)

- Optional, klein: Tests für `proconfig`/`tgnargs`/`lanname`, Negativtest `assertEpochText`, `.gitattributes` für `*.sql`
- Nur bei D-3 = „nicht vertrauenswürdig“: Owner-Härtung (R4-F1, R4-F2, Constraints), danach unabhängiger Review
- Jede weitere Änderung braucht wieder einen unabhängigen Review (Ersteller ≠ Prüfer)
