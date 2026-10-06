# Board-Katalog

**Maschinenlesbare Quelle:** `ai-company/core/org.json`. Diese Datei erklärt die Arbeitsweise
der Boards. Rollen, Profile, KPIs und Status stehen nur in `org.json`. CI prüft sie.

Ausführung: Subagenten können laut Claude-Code-Doku (Radar, 06.10.2026) selbst Subagenten starten.
Die Foundation ist **bewusst flach**: Der Cloud CEO startet alle Agenten selbst, Leads planen und
nehmen ab. Das hält Kosten, Rechte und Nachvollziehbarkeit beim CEO.

| Board | Status | Lead (Agent) | Reviewer | Operativ heute |
|---|---|---|---|---|
| Engineering | FOUNDATION READY | engineering-lead | code-reviewer | ja |
| Security | FOUNDATION READY | security-lead | security-auditor | ja |
| QA & Audit | FOUNDATION READY | qa-lead | final-auditor | ja |
| DevOps / Deployment | PARTIAL | (devops-lead geplant), deploy-verifier | final-auditor | nein: kein Render-Zugang |
| Data / Knowledge | FOUNDATION READY | knowledge-steward | final-auditor | ja (Doku) |
| Finance | FOUNDATION READY | finance-lead | finance-auditor | ja, nur Read-Pipeline |
| Treasury / Cashflow | FOUNDATION READY (Struktur) | board-analyst als treasury-lead | treasury-auditor (geplant) | nein: keine Bankdaten |
| Costing & Menu Engineering | FOUNDATION READY (Struktur) | board-analyst als costing-lead | costing-auditor (geplant) | nein: kein POS, keine Rezepte |
| Purchasing | FOUNDATION READY (Struktur) | board-analyst | purchasing-auditor (geplant) | nein |
| HR & Payroll | FOUNDATION READY (Struktur) | board-analyst als hr-lead | hr-payroll-auditor (geplant) | nein: keine Zeiterfassung |
| Daily COO / Control Tower | FOUNDATION READY | daily-coo | final-auditor | teilweise: nur Finance-Daten |
| Inventory & Prep | FOUNDATION READY (Struktur) | board-analyst | inventory-auditor (geplant) | nein |
| Food Safety / HACCP | FOUNDATION READY (Struktur) | board-analyst | compliance-auditor (geplant) | nein |
| CRM / Guest Intelligence | FOUNDATION READY (Struktur) | board-analyst | privacy-auditor (geplant) | nein |
| Marketing / Social | FOUNDATION READY (Struktur) | board-analyst | brand-compliance-agent (geplant) | nein: Brand-Datei leer |
| SEO / Growth | FOUNDATION READY (Struktur) | board-analyst | growth-auditor (geplant) | nein |
| Sales | FOUNDATION READY (Struktur) | board-analyst | sales-auditor (geplant) | nein |
| Operations | FOUNDATION READY (Struktur) | board-analyst | operations-auditor (geplant) | nein |
| AI / Technology Radar | FOUNDATION READY | technology-radar | security-auditor | ja, manuell |

„FOUNDATION READY (Struktur)“ bedeutet: Rollen, Rechte, KPIs, harte Grenzen und Review-Pfad sind
definiert und CI-validiert. Es gibt aber noch **keine Datenquelle**, daher liefert das Board heute nur Konzept- und
Lückenanalysen.

## Board-spezifische Abläufe

### Finance (Was ist passiert?)
Read-Pipeline: `ai-company/customers/lus/finance-rules.md`. Phase 1 ist nur lesend.

### Treasury (Was passiert mit der Liquidität?)
Treasury ist keine Buchhaltung. Später: Bankbestand + offene Forderungen − Verbindlichkeiten − Löhne
− Miete − Leasing − Steuern − geplante Investitionen ergibt einen 14/30/60-Tage-Forecast. **Keine Zahlungsfreigaben.**

### Costing & Menu Engineering
```
Lieferantenrechnung → Artikel → Preis → Einheit (Gebinde → kg → g) → Ingredient Master
→ Rezeptmenge → Direct Food Cost → variable Kosten → Overhead (nach Kostentreiber) → True Cost
→ Deckungsbeitrag → Marge → Menu Engineering
```
- Preise werden **historisiert**, nie überschrieben. So werden Preistrends, Food-Cost-Trends und Lieferantenvergleiche möglich.
- Es wird zwischen **Direct Food Cost** und **Fully Loaded Cost** unterschieden. Fixkosten werden nicht stumpf durch die Zahl der Gerichte geteilt.
- Später: theoretischer Wareneinsatz (POS × Rezept) gegen tatsächlichen Einkauf, mit Abweichungsanalyse.
- **Verkaufspreise werden nie automatisch geändert.**
- Datenquellen: Einkauf aus dem Accounting (Lexware, vorhanden). POS-Verkäufe (Lightspeed), Rezepte und
  Ingredient Master fehlen: DATA NOT AVAILABLE.

### HR & Payroll
Monatsprozess (aus der Customer Config): 01.–15. Kontrolle · 16.–18. Klärung · 19. Final Pre-Check ·
20. Übergabe an den Steuerberater. Zustände: VORBEREITET → VERSANDBEREIT → VERSENDET →
ZUGESTELLT/BESTÄTIGT, letzteres nur mit technischem Nachweis. Ohne belastbare Bestätigung gilt:
`ROT / ANMELDUNG NICHT NACHWEISBAR`. Stunden werden nie erfunden.

### Daily COO
Der Brief hat feste Abschnitte (siehe Agent-Datei). Jede nicht angebundene Quelle erscheint als
`DATA NOT AVAILABLE`. Der COO schlägt anderen Boards Aufgaben vor. Der CEO entscheidet über die Ausführung.

### Inventory & Prep
Verkäufe + Reservierungen + Events + Wochentag + Saison (+ Wetter) ergeben den Bedarf. Davon wird der Bestand abgezogen.
Ergebnis ist ein Prep- oder Bestellvorschlag. Keine fiktiven Bestände.

### Food Safety / HACCP
Fehlende Aufzeichnungen werden nie rückwirkend erzeugt: `ROT / DOKUMENTATION FEHLT`. Das Board ist für andere Betriebe
wiederverwendbar, die Regeln stehen im Core, betriebsspezifische Pläne in der Customer Config.

### CRM
Nur zulässige Quellen. Jede Kampagnennutzung braucht definierte Consent- und Datenschutzregeln. Kein Kontakt zu
Gästen in Phase 1.

### Marketing / SEO / Sales
Nur Entwürfe. Keine Veröffentlichung, keine direkte Website-Änderung. SEO erzeugt Engineering-Tickets.
Angebote sind Entwürfe für Luigi.

### Technology Radar
Neue Fähigkeit → Radar → Nutzen/Risiko → Security Review → Engineering PoC → QA → Empfehlung →
bei erheblicher Änderung Freigabe durch Luigi → Produktion. Quellen: `ai-company/radar/sources.json`. Es wird nie etwas gekauft.

## KPI-Ownership

Die KPIs je Board stehen in `org.json` (`kpis[].source` = benötigte Datenquelle). Ein KPI ist nur
messbar, wenn seine Quelle in der Customer Config als verifiziert gilt (`kpiAvailability()` in
`ai-company/core/registry.ts`). Heute sind für LU'S nur Finance-KPIs aus dem Accounting messbar.
Alle anderen sind `DATA NOT AVAILABLE`. Keine erfundenen Metriken.
