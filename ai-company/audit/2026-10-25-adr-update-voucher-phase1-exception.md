# ADR: Phase-1-Ausnahme – produktives `update-voucher` für ungeprüfte Belege

Datum: 2026-10-25. Status: **Entscheidung des Owners, nachdokumentiert.** Entscheider: Luigi (Merge von #41 am
2026-10-17, produktiv seit 2026-10-22). Nachgezogene Härtung: dieser Folge-PR. Unabhängiger Review:
`ai-company/audit/2026-10-22-pr41-write-path-review.md`.

## Kontext

Die Hard Rules (`.claude/rules/ai-company-hard-rules.md`) verbieten in Phase 1 Lexware-Schreibvorgänge durch Agenten.
Die tägliche Buchhaltungsroutine braucht genau eine Schreibfähigkeit: einen Beleg aus dem Lexware-Posteingang
(Status `unchecked`) vervollständigen und freigeben. Bis #41 exponierte der Server dafür 16 Schreib-Tools ohne
Protokoll. Am 2026-10-13 wurde die eigene Persistence-Datenbank zurückgestellt; Lexware ist die einzige Datenquelle,
der Abgleich passiert bei jedem Lauf.

## Entscheidung

1. Der Server exponiert in Produktion genau **ein** Schreib-Tool: `update-voucher`
   (`LEXWARE_WRITE_TOOLS=update-voucher`). Unbekannte Namen in der Allowlist beenden ab dem Deploy von #42 den
   Start (fail closed); auf `883b572` ergibt ein Tippfehler noch still 0 Schreib-Tools.
2. `update-voucher` ändert nur Belege mit exaktem Status `unchecked` (`LEXWARE_UPDATE_VOUCHER_UNCHECKED_ONLY=true`);
   der Status wird im selben Aufruf unmittelbar vor dem PUT frisch gelesen. Gebuchte Belege werden nie per API geändert.
3. Jeder Aufruf hinterlässt zwei HMAC-SHA256-verkettete Protokollzeilen (Versuch vor dem Lexware-Aufruf, Ergebnis
   danach) auf stdout – ab dem Deploy von #42; mit statischem Token oder `LEXWARE_AUDIT_KEY` geschlüsselt, sonst
   SHA-256 mit Startwarnung. Das Protokoll ist **pseudonymisiert**, nicht geschäftsdatenfrei: Beleg-ID, Datum und Beträge
   stehen im Klartext, Freitext (Kontaktname, Bemerkung, Belegnummer) nur als HMAC-Fingerprint; Fehlertexte von
   Lexware werden nie kopiert.
4. **Agenten** bleiben read-only: `settings.json` (deny), Guard-Hook und `governance.test.ts` sperren `update-voucher`
   weiterhin. Die Ausnahme gilt für den Server gegenüber dem claude.ai-Connector, also für Luigi selbst.
5. Die Hard Rule „Phase 1 forbids Lexware writes“ bleibt für Agenten in Kraft. Vorschlag für die Formulierung (Änderung
   der Regeldatei nur durch den Owner): „… Lexware writes **by agents** (book/change/upload/delete/finalize); the
   server-side exception `update-voucher` for `unchecked` vouchers is documented in
   `ai-company/audit/2026-10-25-adr-update-voucher-phase1-exception.md`.“

## Bedrohungsmodell (aus dem Review)

Wer das MCP-Bearer-Token hat, kann bei einem Beleg mit Status `unchecked` in einem Aufruf jedes Feld ändern (Status,
Nummer, Datum, Beträge, Steuerart, Kontakt, Positionen, Dateien). Danach ist der Beleg gesperrt. Der GET→PUT-Wettlauf
ist nur durch Lexwares `version`-Prüfung geschützt. Das Token ist damit das zentrale Geheimnis; es liegt nur in Render
und im Connector.

## Nicht entschieden (offen für Luigi)

| # | Frage | Empfehlung |
|---|---|---|
| E-2 | Default bei ungesetzter Allowlist: alle Schreib-Tools mit Warnung (heute) oder `none` (fail closed)? | `none` beim nächsten Major; bis dahin Warnung |
| E-3 | Soll `update-voucher` in Produktion alle Felder ändern dürfen oder nur eine Teilmenge? | Teilmenge nach Ziel der Buchhaltungsautomatik |
| — | Eigenes, bestätigungspflichtiges Buchungs-Tool (Option 3, zweiter Teil der Policy) | nach Festlegung der Automatik |

## Betrieb (Render)

Zu setzen bzw. zu prüfen: `LEXWARE_WRITE_TOOLS=update-voucher`, `LEXWARE_UPDATE_VOUCHER_UNCHECKED_ONLY=true` (beide
aktiv, verifiziert 2026-10-22), neu: `TRUST_PROXY=true`; optional `LEXWARE_AUDIT_KEY` (sonst vom MCP-Token
abgeleitet). Eine Rotation des MCP-Tokens startet ohne `LEXWARE_AUDIT_KEY` eine neue Protokollkette.
