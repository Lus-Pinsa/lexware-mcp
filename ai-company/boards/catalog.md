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
| Treasury / Cashflow | STRUCTURE READY | board-analyst als treasury-lead | treasury-auditor (geplant) | nein: keine Bankdaten |
| Costing & Menu Engineering | STRUCTURE READY | board-analyst als costing-lead | costing-auditor (geplant) | nein: kein POS, keine Rezepte |
| Purchasing | STRUCTURE READY | board-analyst | purchasing-auditor (geplant) | nein |
| HR & Payroll | STRUCTURE READY | board-analyst als hr-lead | hr-payroll-auditor (geplant) | nein: keine Zeiterfassung |
| Daily COO / Control Tower | PARTIAL | daily-coo | final-auditor | teilweise: nur Finance-Daten |
| Inventory & Prep | STRUCTURE READY | board-analyst | inventory-auditor (geplant) | nein |
| Food Safety / HACCP | STRUCTURE READY | board-analyst | compliance-auditor (geplant) | nein |
| CRM / Guest Intelligence | STRUCTURE READY | board-analyst | privacy-auditor (geplant) | nein |
| Marketing / Social | STRUCTURE READY | board-analyst | brand-compliance-agent (geplant) | nein: Brand-Datei leer |
| SEO / Growth | STRUCTURE READY | board-analyst | growth-auditor (geplant) | nein |
| Sales | STRUCTURE READY | board-analyst | sales-auditor (geplant) | nein |
| Operations | STRUCTURE READY | board-analyst | operations-auditor (geplant) | nein |
| AI / Technology Radar | FOUNDATION READY | technology-radar | security-auditor | ja, manuell |

Status (`org.json` → `status`, CI-validiert):
- **FOUNDATION READY** (`foundation-ready`): eigene ausführbare Agenten, Rechte und Review-Pfad vorhanden und belegt.
- **PARTIAL** (`partial`): ausführbar, aber mit fehlendem Zugang oder fehlenden Daten (DevOps: kein Render-Zugang;
  Daily COO: nur Finance-Daten).
- **STRUCTURE READY** (`structure-ready`): **nur Organisationsstruktur, nicht operativ einsatzbereit.** Rollen, Rechte,
  KPIs, harte Grenzen und Review-Pfad sind definiert, aber es gibt **keine Datenquelle und keinen eigenen Agenten**.
  Das Board liefert heute nur Konzept- und Lückenanalysen über den generischen `board-analyst`. Eine Registry-Regel
  verhindert, dass solche Boards als `foundation-ready` oder `partial` markiert werden.

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
`ai-company/core/registry.ts`). Heute haben für LU'S 20 von 51 KPIs eine verbundene Quelle
(`accounting.read`, `code.read`). Davon hat aber nur Finance (und Engineering/Security/QA für `code.read`) einen
Agenten mit Zugriff. KPIs von Costing, Purchasing oder Sales, die aus dem Accounting kommen, sind erst messbar,
wenn diese Boards einen Agenten mit `accounting.read` bekommen. Alles andere: `DATA NOT AVAILABLE`.
Keine erfundenen Metriken.
