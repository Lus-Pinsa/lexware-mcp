# Phase 2 · PR 1: Finance Core & Truth Layer (Evidence)

Branch `claude/busy-knuth-0980fw`, Basis `main` (`090af8b`). Öffentliches Repo: Dieses Dokument enthält keine Geschäftsdaten
(keine Beträge, Namen, Belegnummern oder IDs). Tests nutzen ausschließlich synthetische Fixtures.

## Umfang

| Baustein | Datei(en) |
|---|---|
| Kanonisches Finanzmodell mit Provenienz und Qualität je Wert | `src/finance/model.ts`, `src/finance/values.ts` |
| Exakte Cent-Beträge, Kalendertage Europe/Berlin | `src/finance/money.ts`, `src/finance/dates.ts` |
| Normalisierung (Belegliste, Buchhaltungsbeleg, Verkaufsdokument, Zahlung, Kategorien, Anhänge) | `src/finance/normalize.ts` |
| Datenqualität (feste Schweregrade, nur Zählungen) | `src/finance/quality.ts` |
| Budgetierter Loader, nur über GET-Fassade | `src/finance/loader.ts`, `src/lexware/read-only-client.ts` |
| PDF-Härtung (Größe, Seiten, Timeout, Textlimit, untrusted) | `src/lexware/file-inspection.ts`, `src/lexware/client.ts`, `src/tools/files.ts`, `src/untrusted.ts` |
| `get-server-info` (lokal, read-only, keine Secrets) | `src/tools/server-info.ts`, `src/build-info.ts`, `src/tools/index.ts` |
| Read-only-Regression | `tests/finance-policy.test.ts` (Abschnitt „Phase 2 finance truth layer stays read-only“) |

## Kernregeln des Modells

- Ein fehlender Betrag wird nie zu 0: `value` ist `null`, solange die Qualität nicht STRUCTURED, DERIVED oder UNVERIFIED ist.
- Widersprechen sich Quellen (z. B. Belegliste und Beleg-Detail), entsteht CONFLICT mit allen Kandidaten; kein Wert gewinnt still.
- Steuer 0 bei ungeprüftem Beleg („unchecked“) ohne Positionen ist ein PLACEHOLDER; Netto bleibt dann unbekannt.
- Fälligkeit: `dueDateConfidence` unterscheidet Zahlungsziel laut Dokument, eigenes Fälligkeitsdatum, möglichen Default
  (Fälligkeit = Belegdatum ohne Zahlungsziel) und fehlend.
- Lexware-Einnahmen sind Rechnungserlöse aus Lexware, nicht der Kassen-/POS-Umsatz (`REVENUE_SCOPE_NOTE`).
- Werte aus PDF-Text sind UNVERIFIED und nie Fakten; PDF-Text ist untrusted input.

## Bekanntes offenes Thema: Connector-Metadaten

Eine Claude-Code-Session zeigte nach Neuverbindung weiterhin `acknowledge-voucher-event` (41 statt 40 Tools), während der
Render-Server laut Log `tiers=[read]` meldet. Die serverseitigen Read-only-Gates bleiben unverändert. PR 1 liefert mit
`get-server-info` (Build-Commit, aktive Tiers, exakte Tool-Liste inkl. schreibfähiger Tools) das Werkzeug, um nach dem Deploy
den tatsächlichen Serverstand zu prüfen. Hinweis: Claude Code blendet per `permissions.deny` gesperrte Tools aus; deren
Fehlen in einer Session ist kein Beweis.

## Verbindliche Regeln für PR 2 (aus dem Final-Audit)

- Records mit einem Befund der Schwere CRITICAL (z. B. TOTALS_INCONSISTENT, GROSS_MISSING, VOUCHER_DATE_SOURCES_DIFFER)
  fließen nicht als Fakt in Summen. Sie werden getrennt als „zu prüfen“ mit Anzahl ausgewiesen. Grund: Bei Netto + Steuer ≠
  Brutto innerhalb eines Dokuments bleiben Netto und Steuer STRUCTURED (Lexware hat sie so geliefert) und sind nur über den
  Befund markiert.
- Nur STRUCTURED und DERIVED zählen als belastbar (`isUsable`). UNVERIFIED (z. B. Werte aus PDF-Text) wird nie summiert.
- Lexware-Rechnungserlöse und Kassen-/POS-Umsatz bleiben getrennt (`REVENUE_SCOPE_NOTE`).
- Ein Snapshot mit `completeness.list` ≠ COMPLETE oder mit übersprungenen Details darf keine Gesamtsumme ohne diesen Hinweis
  ausgeben.

## Evidenz

Stand des Final-Audits: Head `5696279`. Danach Fix-Runde 3 (LOW-Befunde des Final-Audits, siehe unten); deren unabhängige
Verifikation steht im PR #4 als Kommentar. Keine Geschäftsdaten; alle Messungen mit synthetischen PDFs und Fixtures.

### Gates auf `5696279`

| Prüfung | Ergebnis | Quelle |
|---|---|---|
| `tsc -b --force` | exit 0 | lokal (Ersteller, Security-Auditor, Final-Auditor) |
| `npm run typecheck:governance` | exit 0 | lokal (Final-Auditor) |
| `vitest run` | 20 Dateien, 471/471, zweimal; kein `.skip`/`.only`/`.todo` | lokal Node 22 (Final-Auditor); CI build-test |
| `npm run secret-scan` | 126 Dateien, 0 Funde | lokal; CI secret-scan |
| `npm audit --omit=dev --audit-level=high` | exit 0 (1 low: esbuild, nur Dev-Server) | lokal; CI audit |
| CI | 7/7 success: build-test, secret-scan, audit, dependency-review, docker, CodeQL analyze, CodeQL | GitHub Actions |

### Review-Loop (Ersteller ≠ Reviewer)

| Runde | Prüfer | Ergebnis | Behoben in |
|---|---|---|---|
| 1 | code-reviewer | REQUEST_CHANGES: Placeholder bei fehlenden Positionen; Netto/Steuer trotz Brutto-Konflikt nutzbar | `4f696a5` |
| 1 | security-auditor | PASS WITH RISKS: Timeout im selben Thread wirkungslos; Seitenmarker verdecken OCR-Bedarf; Lücken bei unsichtbaren Zeichen, Links, Pfaden | `4f696a5` |
| 1 | qa-lead | PASS WITH GAPS: Status-Vokabular, fehlende Tests | `4f696a5` |
| 1 | test-engineer | 43 Adversarial-Tests, 15 rot; unverändert committet (`7de3e97`) | `4f696a5`, danach 43/43 grün |
| 2 | code-reviewer | APPROVE WITH NITS | `5696279` |
| 2 | security-auditor | PASS WITH RISKS: Speicherspitzen, Slot-Leck, Worker-Umgebung, Lücke im Import-Scan | `5696279` |
| Verifikation | security-auditor | PASS WITH RISKS, nichts blockierend (Messung unten) | — |
| Final | final-auditor | PR READY, GRÜN für den Code-Umfang; 10 Befunde LOW/INFO, nichts blockierend | Runde 3 |

Fix-Runden: 3 von höchstens 3. Weitere Befunde führen zu BLOCKED und Eskalation an Luigi, nicht zu Runde 4.

### Fix-Runde 3 (LOW-/INFO-Befunde des Final-Audits)

| Befund | Änderung | Test |
|---|---|---|
| F1 `totalPages` ungültig (negativ, gebrochen, kein Integer) galt als COMPLETE | INVALID_RESPONSE: auf Seite 1 FAILED ohne Zeilen, später PARTIAL | `finance-loader` › review round 3 (5 Fälle) |
| F2 Netto/Steuer bleiben bei TOTALS_INCONSISTENT STRUCTURED | Regel für PR 2 festgeschrieben (oben) | — (Regel, kein Code) |
| F3 CHANGELOG „can no longer … exhaust“ nicht belegt | Formulierung auf gemessenen Wert und offene Instanzgröße geändert | — |
| F4 leere Worker-Umgebung nur per Regex geprüft | Optionen als `parserWorkerOptions`; echter Thread mit genau diesen Optionen sieht keine Elternvariable | `file-inspection` › empty environment |
| F5 Import-Allowlist übersah einfache Anführungszeichen | Regex deckt `"…"` und `'…'` ab | `finance-policy` (Scan) |
| F6 `..%00`, überlange und kaputte Escapes passierten den Pfad-Guard | kodierte Steuerzeichen und fehlerhafte Escapes werden abgelehnt | `read-only-client` › dot-segment guard (7 Fälle) |
| F7 `download-file` ohne Größenlimit | unverändert, vorbestehend; PR 5 | — |
| F8 Worker-Ausgabe wurde bis zum Ende gepuffert | Ausgabe wird verworfen | Bestandstests |
| F9 `parser_busy` als „fetched“ gezählt; Sortierung mit `localeCompare` | eigener Zähler `skippedBusy`, Status SKIPPED; Code-Unit-Sortierung | `finance-loader` › review round 3 |
| F10 Evidenz-Abschnitt leer | dieser Abschnitt | — |

Gegenprobe: Ohne die Quellcode-Änderungen der Runde 3 schlagen alle 15 neuen Tests fehl.

### PDF-Härtung: Messung des Security-Auditors (echter `get-voucher-file-text`-Handler, Standardlimits)

| Synthetisches PDF | Status | Dauer | max. Event-Loop-Lücke | Spitzen-RSS |
|---|---|---|---|---|
| 100 MB Text-Operatoren | parse_error (Speicher-Watchdog) | 5,9 s | 27 ms | 445 MB |
| 1 GB Text-Operatoren | parse_error (Speicher-Watchdog) | 7,2 s | 24 ms | 500 MB |
| 400 MB Operatoren | parse_timeout | 15,0 s | 25 ms | 494 MB |
| 2 GB Operatoren | parse_timeout | 15,0 s | 24 ms | 505 MB |
| 3 Bomben gleichzeitig | 1 × parse_error, 2 × parser_busy | 6,5 s | — | 451 MB |

Vor Runde 2: bis 879 MB je Bombe, 1553 MB bei zwei gleichzeitigen Bomben. Normale PDFs ergeben `text_extracted` bzw.
`ocr_required` in rund 0,25 s. Eine im Elternprozess gesetzte Test-Variable war im echten Parser-Worker nicht sichtbar.

### Laufzeit (gebauter Server, `LEXWARE_READ_ONLY=true`, lokal)

- `tools/list`: 41 Tools, 0 schreibfähig, kein `acknowledge-voucher-event`.
- `get-server-info`: Build-Commit, `tiers=[read]`, `writeCapable=[]`; API-Key, Token und Webhook-Schlüssel nicht enthalten.
- OAuth: ungültiges Token 401, fremde oder unbestätigte Domain 403.
- Schattenprüfung des Normalizers an echten Lexware-Datenformen: 13/13, nur lokal; die Rohdaten wurden danach gelöscht, nichts
  committet.

### Restrisiken (nicht blockierend, nicht erledigt)

- Instanzgröße auf Render: DATA NOT AVAILABLE. Ein feindliches PDF treibt den Prozess auf Start-RSS + höchstens etwa 384 MB
  (gemessen etwa 500 MB). Bei 512 MB RAM grenzwertig; dann `PARSER_MAX_RSS_GROWTH_MB` senken.
- Der Watchdog misst den Speicher des ganzen Prozesses: Paralleles Wachstum kann einen legitimen Parse abbrechen
  (fail-closed als parse_error).
- Ein Parser je Prozess: gleichzeitige Aufrufe erhalten `parser_busy` (wiederholbar).
- `download-file` und `render-*-pdf` haben weiterhin kein `maxBytes` (vorbestehend; PR 5).
- Nicht verifizierte Lexware-Semantik: Vorzeichen von `openAmount` bei Verbindlichkeiten, Sammelkontakte,
  Abschluss-/Abschlagsrechnungen (Doppelzählung), Vorzeichen bei Gutschriften. Im Modell als Befund sichtbar.
- Echte Datenmengen und das Verhalten im Render-Container (Worker-Threads, pdf-parse) sind offline nicht beweisbar; der Loader
  wird erst mit PR 2 von einem Tool genutzt.
- Ob `RENDER_GIT_COMMIT` in Produktion gesetzt ist, ist unbewiesen (sonst meldet `get-server-info` UNKNOWN).
- Connector-Metadaten: erst nach dem Deploy über `get-server-info` prüfbar.
- Typfehler in älteren Testdateien (nur Typecheck der Tests, die Laufzeit ist unberührt); Commit `7de3e97` ist allein
  absichtlich rot.
- Git kann die Trennung der Agenten nicht beweisen (alle Commits mit derselben Autorenkennung); die Trennung ist im
  Session-Verlauf dokumentiert.
