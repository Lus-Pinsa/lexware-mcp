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

## Evidenz

_Wird nach den unabhängigen Reviews ergänzt._
