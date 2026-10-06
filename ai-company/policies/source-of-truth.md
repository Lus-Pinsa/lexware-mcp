# Policy: Source of Truth und Wissens-Governance

Verantwortlich ist der **Knowledge Steward** (`.claude/agents/knowledge-steward.md`).
Die Zuordnung je Kunde steht in `ai-company/customers/<id>/customer.json` → `sourcesOfTruth`.

## Regeln

1. **Das Primärsystem gewinnt immer.** Beispiel Finance: Lexware schlägt Queue, Chat-Verlauf und Agent-Notiz.
2. Jede Geschäftsangabe hat **Wert, Quelle, Abrufzeitpunkt und Owner**. Ohne Quelle gibt es keine Aussage.
3. **Fehlende Daten** werden als `DATA NOT AVAILABLE` ausgewiesen, nie geschätzt.
4. **Konflikte** (zwei Boards, zwei Werte) werden gemeldet und nicht still aufgelöst.
5. **Veraltung:** Jede Domäne hat eine Freshness-Grenze. Live-Systeme werden live gelesen, Masterdateien tragen ein
   Versionsdatum.
6. **Businessregeln** liegen in der Customer Config, nicht im Core.
7. **Öffentliches Repository:** Es wird nur festgehalten, *wo* eine Wahrheit liegt, nicht der
   vertrauliche Wert. Belegdaten, Personaldaten, Gästedaten, Bankdaten und Steuernummern kommen nie ins
   Repo. CI prüft das per Secret- und Business-Data-Scanner.

## Versionierung

- Konfiguration und Policies werden über Git versioniert (PR plus Review).
- Masterdaten, die später kommen (Rezepte, Ingredient Master, Preis-Historie), liegen nicht in diesem
  öffentlichen Repo. Sie gehören in ein noch zu bestimmendes privates System. Die Entscheidung trifft Luigi in der Costing-Phase.
- Einkaufspreise werden **historisiert, nie überschrieben**, z. B. `01.08. 9,80 €/kg →
  15.09. 10,40 €/kg → 06.10. 12,00 €/kg`.
