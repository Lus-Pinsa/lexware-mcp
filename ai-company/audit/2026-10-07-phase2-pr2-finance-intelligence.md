# Phase 2 · PR 2: Finance Intelligence (Fachdesign, Invarianten, Evidenz)

Ausgangsstand: `main` = `d238b74` (Squash-Merge von PR #4, inhaltlich identisch mit dem geprüften Stand `0a9b20d`).
Branch `claude/busy-knuth-0980fw`, frisch von `main`, ohne Altänderungen. Öffentliches Repo: Dieses Dokument enthält
keine Geschäftsdaten (keine Beträge, Namen, Belegnummern, IDs oder Belegzahlen).

## Ziel und Abgrenzung

Deterministische Management-Aussagen aus dem kanonischen Modell von PR 1: Dubletten, offene Posten, Zeitraumvergleich,
Datenqualität, Daily Finance Brief. Nicht enthalten: Persistenz, Webhook-Härtung, Lightspeed/POS, jegliche Writes.

## Invarianten (für alle Module)

1. **Read-only.** Neue Tools liegen ausschließlich im Read-Tier, lesen nur über die GET-Fassade und schreiben keinen
   serverinternen Zustand. Die produktive Write-Tool-Liste bleibt unverändert.
2. **Pure und deterministisch.** Fachmodule (`src/finance/duplicates.ts`, `open-items.ts`, `periods.ts`,
   `data-quality.ts`, `brief.ts`, `calendar.ts`, `amounts.ts`) haben keine I/O, lesen keine Uhr und keinen Zufall.
   Stichtag und Abrufzeit werden übergeben. Gleiche Eingabe ergibt die gleiche Ausgabe, auch bei anderer
   Reihenfolge der Eingabe-Records (byte-identischer Brief).
3. **Datenwahrheit.** Nur `isUsable` (STRUCTURED/DERIVED) zählt als Fakt. MISSING, PLACEHOLDER, CONFLICT und UNVERIFIED
   fließen nie in Summen, Vergleiche oder Dublettenregeln ein; fehlende Beträge werden nie zu 0. Konflikte werden
   sichtbar ausgewiesen, nie aufgelöst.
4. **CRITICAL-Regel aus PR 1.** Records mit einem CRITICAL-Befund fließen nicht als Fakt in Summen; sie werden mit
   Anzahl als ausgeschlossen ausgewiesen.
5. **Unvollständige Daten.** Ist die Belegliste nicht vollständig geladen (PARTIAL/FAILED), werden Summen als
   unvollständig markiert, Auffälligkeiten nicht bewertet und der Brief steht auf ROT.
6. **Sprachregel.** Lexware-Rechnungserlöse sind nicht der LU'S-Umsatz. Jede Erlöszahl trägt den Hinweis
   `REVENUE_SCOPE_NOTE`. Der Brief verwendet nie „Umsatz“ außer im Hinweis „Nicht identisch mit dem Kassen-/POS-Umsatz“
   und nie Behauptungen wie „wurde bezahlt/gebucht/gelöscht/überwiesen“; Status werden als „laut Lexware-Status“
   formuliert.
7. **Fremdtext.** Lieferantennamen und Belegnummern stammen aus Lexware (oft OCR) und sind untrusted: bereits in PR 1
   bereinigt, im Brief zusätzlich gekürzt und in «» eingefasst (« » im Text werden ersetzt, damit die Begrenzer nicht
   gefälscht werden können).
8. **Geld.** Ganzzahlige Cent je Währung, nie währungsübergreifend summiert. Summen mit Überlaufprüfung
   (`Number.isSafeInteger`); ein Überlauf macht die Kennzahl nicht berechenbar statt falsch. Relative Änderungen exakt
   mit BigInt; Division durch 0 ergibt „nicht definiert“, nie Unendlich.

## Schattenprüfung an echten Daten (nur GET, nichts gespeichert, nur Form/Semantik)

| Annahme | Befund | Folge im Design |
|---|---|---|
| `openAmount` bei Einkaufsrechnungen | positiv, gleiches Vorzeichen wie `totalAmount` | offene Verbindlichkeiten als positive Beträge; negative offene Beträge gelten als Datenfehler |
| Ungeprüfte Belege (`unchecked`) | `openAmount` fehlt, Betrag/Nummer/Kontakt teils fehlend, Kontakt nur als Name | ungeprüfte Belege sind nie „offen“ oder „bezahlt“ (STATUS_UNKNOWN); Abdeckung separat |
| Fälligkeit = Belegdatum | bei den meisten Einkaufs- und Verkaufsrechnungen | ohne Zahlungsziel nur „möglicherweise überfällig“ |
| Verkaufsrechnung (Detail) | `paymentConditions.paymentTermDuration` vorhanden (z. B. 0 = sofort) | Detailabruf für offene Verkaufsbelege macht die Fälligkeit belastbar (PAYMENT_TERM) |
| Belegeingang | identische Rechnungen mehrfach hochgeladen (gleicher Lieferantenname, Nummer, Betrag, Datum) | Regel E2 mit Namens- oder Kontakt-ID-Abgleich |
| Wiederkehrende Rechnungen eines Lieferanten | gleicher Betrag, unterschiedliche Nummern | unterschiedliche Rechnungsnummern schließen Dubletten aus |
| Gutschriften | im geprüften Zeitraum nicht vorhanden | Vorzeichen und Richtung bleiben unverifiziert: Gutschriften werden nie verrechnet, Richtung UNKNOWN |

## 1. Dubletten (`src/finance/duplicates.ts`)

Paare werden nur innerhalb gleicher Art (EXPENSE/REVENUE) und gleicher Rolle (Rechnung, Gutschrift, Abschlag) gebildet;
stornierte (VOIDED) und Entwurfsbelege (DRAFT) sowie nicht-finanzielle Belege werden nicht gepaart (mit Anzahl).
Gleiche Lexware-ID ist derselbe Beleg, keine Dublette (doppelte Eingabe wird gezählt und entfernt).

Vergleichsmerkmale je Paar (alle im Ergebnis sichtbar):

- **Datei-Hash:** gemeinsamer SHA-256 eines Anhangs (nur wenn Anhänge geprüft wurden).
- **Gegenpartei:** gleiche Kontakt-ID oder gleicher normalisierter Name; Konflikt oder fehlend: nicht vergleichbar.
- **Belegnummer:** normalisiert (NFKC, Großschrift, nur Buchstaben/Ziffern); nur unterscheidungskräftig mit
  mindestens 3 Zeichen und einer Ziffer ungleich 0.
- **Betrag:** Brutto in Cent, gleiche Währung, ungleich 0; sonst nicht vergleichbar.
- **Belegdatum:** gleicher Tag, innerhalb 14 Tagen (konfigurierbar) oder außerhalb.

Regeln (erste zutreffende gewinnt; die Regel-ID ist die reproduzierbare „Confidence“, es gibt keinen Zahlenwert):

| Regel | Bedingung | Klasse |
|---|---|---|
| E1 | gemeinsamer Datei-Hash | EXACT_DUPLICATE |
| E2 | gleiche Gegenpartei + gleiche Nummer + gleicher Betrag + gleicher Tag | EXACT_DUPLICATE |
| P1 | gleiche Gegenpartei + gleiche Nummer + gleicher Betrag (anderer oder unbekannter Tag) | PROBABLE_DUPLICATE |
| S2 | gleiche Gegenpartei + gleiche Nummer, Betrag abweichend oder unbekannt | POSSIBLE_DUPLICATE |
| S3 | gleiche Nummer + gleicher Betrag + innerhalb 14 Tagen, Gegenpartei abweichend oder unbekannt | POSSIBLE_DUPLICATE |
| S1 | gleiche Gegenpartei + gleicher Betrag + innerhalb 14 Tagen, Nummern nicht verschieden | POSSIBLE_DUPLICATE |
| — | sonst | NOT_DUPLICATE |

Garantie: Jede Regel braucht mindestens zwei unabhängige Merkmale, darunter Hash, Nummer oder Gegenpartei. Ein gleicher
Betrag allein (auch mit gleichem Datum) erzeugt nie eine Dublette. Die Engine verändert, markiert oder löscht keine Belege.

## 2. Offene Posten (`src/finance/open-items.ts`)

Richtung: EXPENSE → Verbindlichkeit, REVENUE → Forderung; Gutschriften und unbekannte Belegtypen → Richtung unbekannt
(nie in Forderungs-/Verbindlichkeitssummen). Fälligkeit gilt nur als belastbar bei `dueDateConfidence` PAYMENT_TERM
oder LEXWARE_FIELD.

| Lexware-Status | Bedingung | Klasse |
|---|---|---|
| paid/paidoff | offener Betrag belastbar = 0 | PAID_CONFIRMED |
| paid/paidoff | offener Betrag > 0, negativ, fehlend oder Konflikt | STATUS_UNKNOWN |
| open/overdue | offener Betrag = 0 oder negativ | STATUS_UNKNOWN |
| open/overdue | Fälligkeit belastbar und überschritten | OVERDUE_CONFIRMED |
| open/overdue | Fälligkeit belastbar, nicht überschritten, Lexware sagt „overdue“ | POSSIBLY_OVERDUE |
| open/overdue | Fälligkeit belastbar, nicht überschritten | OPEN_CONFIRMED |
| open/overdue | Fälligkeit = Belegdatum ohne Zahlungsziel und überschritten | POSSIBLY_OVERDUE |
| open/overdue | Fälligkeit = Belegdatum ohne Zahlungsziel, nicht überschritten | DUE_DATE_UNRELIABLE |
| overdue | Fälligkeit fehlt oder Konflikt | POSSIBLY_OVERDUE |
| open | Fälligkeit fehlt oder Konflikt | DUE_DATE_UNRELIABLE |
| unchecked, Status mit unverifizierter Bedeutung (z. B. sepadebit), unbekannt, Konflikt | — | STATUS_UNKNOWN |
| draft, voided, nicht-finanziell | — | ausgeschlossen (gezählt) |

Je Posten: Brutto, offener Betrag (mit Qualität), Fälligkeit und deren Grundlage, Alter in Tagen ab Belegdatum (nur wenn
belastbar), Tage über Fälligkeit (nur bei OVERDUE_CONFIRMED), Gründe der Unsicherheit. Summen nur aus belastbaren
offenen Beträgen ohne CRITICAL-Befund; offener Betrag größer als Brutto gilt als Datenfehler. Abdeckung: Belege vor dem
Beginn des Ladefensters werden nicht geprüft; das wird ausgewiesen.

## 3. Zeitraumvergleich (`src/finance/periods.ts`, `calendar.ts`)

Zeiträume nach Belegdatum (Kalendertag Europe/Berlin): aktueller Monat bis Stichtag (MTD), Vormonat gleicher Zeitraum
(Tag auf Monatsende des Vormonats begrenzt, z. B. 31.03. → 01.–28./29.02.) und kompletter Vormonat.

Kennzahlen je Zeitraum: Anzahl Einkaufsbelege (inkl. ungeprüfter), belastbare Ausgaben (brutto, nur geprüfte
Einkaufsrechnungen ohne CRITICAL-Befund), Lexware-Rechnungserlöse (brutto, nur geprüfte Verkaufsrechnungen; Abschlags-
rechnungen und Gutschriften nicht enthalten, aber gezählt), heute noch offene Beträge der Belege des Zeitraums,
ungeprüfte Belege, größte Lieferanten (nur geprüfte Belege mit identifizierter Gegenpartei; nicht zugeordnete separat).
Kostenpositionen (Buchungskategorien) nur, wenn Belegdetails geladen wurden; sonst „nicht verfügbar“.

Differenzen: absolut in Cent und relativ in Prozent (eine Nachkommastelle, kaufmännisch gerundet); Vergleichsbasis 0 →
relativ „nicht definiert“.

## 4. Auffälligkeiten

Regel (konfigurierbar, Standard): |relative Änderung| ≥ 30 % **und** |absolute Änderung| ≥ 250,00 €. Die Schwellen werden
exakt geprüft (ganzzahlig/BigInt, keine Rundung). Bewertet wird nur gleichartig: MTD gegen Vormonat gleicher Zeitraum,
für belastbare Ausgaben, Lexware-Rechnungserlöse und je Lieferant (nur EUR). Nicht bewertet (mit Grund) wird, wenn die
Belegliste unvollständig ist, die Basis 0 ist, ein Wert nicht berechenbar ist oder bei Ausgaben/Lieferanten der Anteil
ungeprüfter Einkaufsbelege in einem der Zeiträume über 10 % liegt (sonst entstünden Schein-Rückgänge durch den
Belegeingang).

## 5. Datenqualität (`src/finance/data-quality.ts`)

Kein Score, sondern eine Einstufung aus konkreten, gezählten Befunden mit dokumentierten, konfigurierbaren Schwellen:

| Einstufung | Bedingung (Standard) |
|---|---|
| NO_DATA | Liste vollständig, aber keine finanzrelevanten Belege im Umfang |
| POOR | Belegliste nicht vollständig geladen, oder ≥ 10 % der geprüften Belege mit CRITICAL-Befund |
| LIMITED | mindestens ein geprüfter Beleg mit CRITICAL-Befund, oder ≥ 25 % ungeprüfte Belege, oder ≥ 25 % ohne identifizierte Gegenpartei, oder Detail-/Zahlungsabrufe fehlgeschlagen, oder ≥ 50 % der offenen Posten ohne belastbare Fälligkeit |
| GOOD | sonst |

Gezählte Befunde: fehlender Betrag, Quellenkonflikt, fehlende Gegenpartei, ungeprüfter Beleg, unzuverlässige
Fälligkeit, fehlende Zahlungsinformation, unklare Richtung, fehlendes Belegdatum, CRITICAL-Befund, fehlgeschlagene Abrufe.
Anteile werden ganzzahlig geprüft (`Anzahl × 100 ≥ Schwelle × Basis`).

## 6. Daily Finance Brief (`src/finance/brief.ts`)

Strukturiertes Modell plus Text-Renderer aus Code, ohne LLM-Text, ohne Uhr (Stichtag und Abrufzeit sind Eingabe),
eigenes deutsches Zahlenformat (kein `Intl`), feste Reihenfolgen und Listenlimits.

Status:

- **ROT:** Belegliste nicht vollständig geladen; oder Datenqualität POOR; oder exakte Dublette zwischen zwei geprüften
  Belegen.
- **GELB:** sonst, sobald mindestens ein Punkt „Owner Attention“ besteht (Dubletten-Verdacht, belastbar oder möglicherweise
  überfällige Posten, Posten ohne belastbare Fälligkeit, Auffälligkeiten, Datenqualität LIMITED).
- **GRÜN:** sonst. Der Brief nennt dann die Prüfungen und Zählungen, auf denen GRÜN beruht.

## 7. MCP-Tools (Read-Tier, `src/tools/finance-intelligence.ts`)

| Tool | Frage | Warum eigenes Tool |
|---|---|---|
| `get-finance-snapshot` | Welche Daten liegen zugrunde, wie vollständig und wie gut? | Nachvollziehbarkeit: kompakte Records mit Qualität und Befunden, Vollständigkeit, Datenqualität |
| `analyze-voucher-duplicates` | Gibt es Dubletten? | eigener Zeitraum, optionale Hash-Prüfung nur für Kandidaten |
| `get-open-items` | Was ist offen oder überfällig? | eigenes Rückblickfenster, Details nur für offene Verkaufsbelege |
| `compare-finance-periods` | Wie steht der Monat im Vergleich? | Stichtag wählbar, Auffälligkeitsregel |
| `get-finance-daily-brief` | Gesamtlage heute | ein einziger Ladevorgang für alle Auswertungen, deterministischer Text |

Alle Tools: Request-Budget, PARTIAL/FAILED sichtbar, keine Seiteneffekte. Standard ist nur die Belegliste;
Detailabrufe sind gezielt (offene Verkaufsbelege; Dubletten-Kandidaten bei Hash-Prüfung).

## 8. Testmatrix

| Bereich | Fälle |
|---|---|
| Dubletten | gleicher Hash; gleiche Nummer (+ Gegenpartei, + Betrag); gleicher Betrag, anderer Lieferant; gleicher Lieferant + Betrag außerhalb 14 Tagen; gleiche Nummer, abweichender Betrag; fehlende Werte; Konflikte; Gutschriften; nicht unterscheidungskräftige Nummern; Betrag 0; Symmetrie, Permutation, Paarlimit, Fuzz |
| Offene Posten | bestätigt offen; bestätigt bezahlt; belastbar überfällig; unzuverlässige Fälligkeit; fehlende Zahlungsinfo; unbekannte Richtung; Widersprüche Status/Betrag; CRITICAL-Ausschluss; Fuzz-Invarianten |
| Zeitraum | MTD; Monatsgrenzen; Jahreswechsel; Februar/Schaltjahr; Europe/Berlin; Division durch 0; fehlende/Konflikt-Werte; Überlauf; Auffälligkeitsgrenzen exakt |
| Datenqualität | jede Schwelle an der Grenze; NO_DATA; unvollständige Liste |
| Brief | deterministisch und byte-identisch (auch permutiert); keine verbotenen Formulierungen; PARTIAL; FAILED; Warnungen; Fremdtext-Begrenzer |
| Policy | neue Tools read-only (auch READ_ONLY-Modus); Write-Liste unverändert; keine Mutation; keine Secrets; keine Uhr/kein Zufall in Fachmodulen; keine Geschäftsdaten in Fixtures |

## Evidenz

_Wird nach den unabhängigen Reviews ergänzt._
