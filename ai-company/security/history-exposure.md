# Public Git History Incident: Exposure Assessment and Cleanup Plan

Stand: Security Architecture Gate, `main` = `8f938aa`. Die Analyse ist unabhängig erfolgt und nur lesend. Dieses Dokument enthält **keine Werte**, nur Typen und Anzahlen.
**Es wurde nichts umgeschrieben, nichts force-gepusht und kein Branch gelöscht.** Jede Option außer (a) braucht eine separate Owner-Freigabe.

## 1. Was offenliegt

| | |
|---|---|
| **Datentypen** | 8 verschiedene EUR-Beträge (Dezimalform), davon 5 zusätzlich in Cent-Form. 3 weitere ganze Zahlen ≥ 100. 39 Zeitstempel-Strings, die etwa 13 verschiedene Zeitpunkte beschreiben, davon 11 mit Sekunden und mehrere mit Millisekunden. 1 Testrechnungsnummer mit veränderten Ziffern, deren Herkunft aus einer echten Nummernfolge nicht verifizierbar ist. |
| **Nicht enthalten** | Namen, Lexware-IDs, E-Mails, IBANs, Steuer-IDs (geprüft in allen Commits, Commit-Nachrichten, PR-Texten, Reviews und Kommentaren). |
| **Commits** | `855cbbc`, `d7ec39c`, `dc3cb86`, `7de3e97`, `4f696a5`, `5696279`, `0a9b20d` (PR-#4-Head) sowie `d238b74` (PR-#4-Squash auf `main`). Ab `69f2608` (PR 2) und auf `8f938aa` sind die Werte entfernt. |
| **Dateien (in `d238b74`)** | `tests/fixtures/finance-fixtures.ts`, `tests/finance-adversarial.test.ts`, `tests/finance-normalize.test.ts`, `tests/finance-money-dates.test.ts`, `tests/finance-loader.test.ts`, `src/finance/dates.ts` (ein Kommentarbeispiel) |
| **Öffentlich seit** | 2026-10-06, zwischen 22:28 und 22:59 UTC (erster Push des PR-1-Branches). Auf `main` seit 2026-10-07 07:07 UTC (Merge von PR #4). |
| **Refs, die die Werte erreichbar halten** | `main` (über den Vorfahren `d238b74`), alle Branches darauf, `refs/pull/4/head` (nicht durch Nutzer löschbar; einziger Ref der sieben Einzel-Commits), `refs/pull/5/head`, `refs/pull/6/*`. Dazu Diff-Ansichten: „Files changed“ von PR #5 und die Commit-Seite von `69f2608` zeigen die alten Werte als gelöschte Zeilen. |
| **Fork-Netzwerk** | Das Repo ist ein Fork (Parent `Welp-IT/lexware-mcp`, Quelle `marselsel/Lexware-MCP-Server`, `network_count` 16, `forks_count` 0). **Bestätigt:** Die betroffene Datei ist über `raw.githubusercontent.com` auch unter den Repos `Welp-IT/…` und `marselsel/…` per Commit-SHA abrufbar (HTTP 200, gleicher Blob-Hash; Gegenproben mit erfundener SHA ergaben 404). Grund ist der gemeinsame Objektspeicher des Fork-Netzwerks (Cross-Fork Object Reference). |
| **Caches und Archive** | Nicht geprüft, möglich: GitHub-Diff-Caches, Software Heritage, Suchmaschinen-Caches, Klone Dritter. GH Archive speichert nur Ereignis-Metadaten (SHAs, Nachrichten), keine Dateiinhalte. Clone-Zahlen: DATA NOT AVAILABLE. |

### Rest auf `main` (R1)

`69f2608` hat nur die Uhrzeiten und Beträge ersetzt. Die **Kalendertage** der Fixture-Datensätze sind geblieben: 8 verschiedene Tage im September und Oktober 2026, 5 davon entsprechen Tagen der entfernten Zeitstempel. Ob diese Tage aus echten Belegen stammen, lässt sich aus dem Repository nicht mehr belastbar klären. **Fail closed: Sie gelten als möglicherweise echt.**

Einzeln, ohne Betrag, Uhrzeit, Gegenpartei und ID, sagen sie nur „an diesem Tag gab es einen Beleg“. Deshalb sind sie als LOW-Rest eingestuft. Werden sie ersetzt, muss die PR-1-Testmatrix angepasst werden, denn Monatsgrenzen und Zeiträume hängen an diesen Tagen. Das geschieht deshalb in einem eigenen PR mit Gegenprobe (Owner-Aktion O-H2).

### Dokumentationsbefunde

- **F1 (Hinweisschild):** `CHANGELOG.md` und die Commit-Nachricht von `69f2608` sagen öffentlich, dass PR-1-Fixtures Werte aus echten Belegen enthielten. Das bleibt aus Transparenzgründen so; es wird kein Werteinhalt genannt.
- **F2 (falsche Aussage, korrigiert in diesem PR):** `ai-company/audit/2026-10-06-phase2-pr1-truth-layer.md` behauptete „nur synthetische Fixtures“. Für PR 1 in der gemergten Form stimmte das nicht. Die Korrektur steht als Nachtrag im Dokument.

## 2. Risiko: **LOW**

| Faktor | Bewertung |
|---|---|
| Zugangsdaten, IDs, Namen | keine |
| Umfang | klein: etwa 8 Beträge und 13 Zeitpunkte |
| Zuordnung zum Unternehmen | ja, über den Repository-Namen |
| Zuordnung zu Gegenparteien | nur mit Vorwissen: Eine Gegenpartei, die Betrag und Datum ihrer eigenen Rechnung kennt, kann sie wiedererkennen. Ein Datensatz war eine Ausgangsrechnung mit Status offen bzw. überfällig. Falls sie echt ist, könnte der Kunde erfahren, dass sie als überfällig markiert war. DSGVO-relevant ist das nur, wenn der Kunde eine natürliche Person ist. |
| Wettbewerbsrelevanz | gering (einzelne Transaktionen, keine Summen) |
| Dauerhaftigkeit | Die Werte bleiben über `refs/pull/4/head` und das Fork-Netzwerk erreichbar, auch nach einem Rewrite |

Eine Höherstufung auf MEDIUM folgt, wenn sich ein Datensatz einer natürlichen Person zuordnen lässt oder die Rechnungsnummer einer echten Nummernfolge entspricht.

## 3. Cleanup-Plan (Optionen; **nichts davon ist ausgeführt**)

| Option | Schritte | Entfernt | Entfernt **nicht** | Nebenwirkungen | Freigabe |
|---|---|---|---|---|---|
| **(a) Akzeptieren und dokumentieren** *(Empfehlung)* | Vorfall dokumentieren (dieses Dokument). F2 korrigieren (erledigt). R1 in einem eigenen PR ersetzen. Scan-Regel gegen echte Zeitstempel in Fixtures ergänzen (Folge-PR). Lehre im Review-Verfahren festhalten. | nichts Bestehendes | alles bereits Veröffentlichte | keine; SHAs, PR-Links und PR #6 bleiben intakt | Owner akzeptiert das LOW-Restrisiko |
| **(b) Rewrite von `main` + Force-Push** | Frischer Mirror-Klon. `git filter-repo --replace-text` auf die 6 Dateien. Prüfen mit Token-Scan, Tests und Secret-Scan. Ruleset temporär lockern (`non_fast_forward`). Force-Push. Ruleset sofort wiederherstellen. PR #6 neu aufsetzen. Alle Klone verwerfen. | Werte aus `main` und neuen Klonen | `refs/pull/4/head`, `/5/head`, `/6/*`; Diff-Ansichten von PR #4 und #5; Objekte im Fork-Netzwerk (per SHA über Parent und Quelle abrufbar); Archive, Klone | Neue SHAs ab `d238b74`; tote „merged as“-Links; veraltete SHA-Verweise in Dokumenten; offener PR betroffen; kurzes Fenster ohne Branch-Schutz | Owner: Force-Push und Ruleset-Änderung (HARD STOP für Agents) |
| **(c) GitHub-Support „Removing sensitive data“** | Nach (b): Antrag mit betroffenen SHAs und PRs #4, #5, #6; Bitte um Entfernung gecachter Ansichten, PR-Refs und unreferenzierter Objekte im Netzwerk | gecachte Ansichten, PR-Refs, dangling objects (nach Ermessen von GitHub) | Archive Dritter, Klone | PR #4 und #5 können Diffs und Commit-Listen verlieren; der Support kann Anträge mit geringer Sensibilität ablehnen | Owner stellt den Antrag |
| **(d) Fork-Netzwerk verlassen** | Settings → Danger Zone → „Leave fork network“, falls angeboten, sonst Support | künftige Cross-Fork-Referenzen | bereits geteilte Objekte (bis zur GC durch GitHub) | „Forked from“-Link und Upstream-PR-Weg gehen verloren | Owner |
| **(e) Repository privat machen** | erst (d), dann Sichtbarkeit privat | öffentliche Sicht auf `main` und die PRs | Netzwerkobjekte bis zur GC, Archive, Klone | Projekt nicht mehr Open Source (Widerspruch zu `AGENTS.md`); mögliche Kosten für Actions und Features | Owner (Produktstrategie, Kosten) |

**Empfehlung: (a).** (b) und (c) zusammen kosten einen SHA-Rewrite von `main`, ein Fenster ohne Branch-Schutz, einen gestörten PR und PR-Historie. Wegen PR-Refs, Fork-Netzwerk, Archiven und der bereits verstrichenen Zeit garantieren sie trotzdem keine Entfernung. Für namenlose LOW-Daten ist das unverhältnismäßig. (b) + (c) + (d) kommen erst in Betracht, wenn sich ein Personenbezug oder eine echte Nummernfolge bestätigt.

## 4. Lehren und Controls

- **Ursache:** Testfixtures wurden aus der Form echter Belege abgeleitet, und Werte wurden übernommen statt erfunden. Die Review prüfte auf Namen und IDs, nicht auf Beträge und Zeitstempel.
- **Regel (gilt ab sofort):** Fixtures enthalten nur erfundene Werte: runde Beträge, Zeitstempel mit `:00.000` Sekunden, `TEST-`-Nummern, Null-UUIDs (`data-classification.md`).
- **Control (Folge-PR):** Eine Scan-Regel markiert in `tests/` Zeitstempel mit Sekunden oder Millisekunden ungleich null und Beträge mit Cent-Anteil außerhalb einer Allowlist. Sie läuft nur auf neue Änderungen.
- **Fork-Netzwerk:** Jeder Push in dieses Repo ist dauerhaft über das gesamte Netzwerk per SHA erreichbar. Push Protection und Secret-Scan vor dem Push sind deshalb die einzigen wirksamen Controls; ein späteres Löschen hilft nicht.
- **Agents:** PRs immer explizit gegen `Lus-Pinsa/lexware-mcp` öffnen. Werkzeuge, die bei Forks standardmäßig das Parent-Repo als Basis wählen, würden LU'S-Inhalte in ein fremdes Repo tragen.
