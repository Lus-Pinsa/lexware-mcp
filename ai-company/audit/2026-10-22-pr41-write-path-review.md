# Unabhängiger Review: PR #41 – Schreibpfad `update-voucher` (main `883b572`)

Datum: 2026-10-22. Anlass: #41 wurde am 17.10. ohne dokumentierten Security-Sign-off gemergt und läuft seit
2026-10-22 10:22 UTC in Produktion. Dieser Review liefert den Sign-off nach (`finance-write-gates.md`, „Regel für
Phase 2“). Zwei getrennte Prüfinstanzen (Security-Audit, Code-Review), die den Code nicht geschrieben haben,
read-only, ohne Lexware-Aufrufe, nur synthetische Daten. Orchestrierung und Governance-Abgleich: Claude Code.

## Ergebnis

| Prüfung | Verdikt | Status |
|---|---|---|
| Security-Audit | PASS WITH RISKS | GELB |
| Code-Review | REQUEST CHANGES (Folge-PR, kein Revert nötig) | GELB |

**Gesamt: GELB.** #41 verengt die Schreibfläche von 16 auf 1 Tool, hebelt kein bestehendes Gate aus und ist
korrekt umgesetzt. Es gibt keine Befunde mit CRITICAL oder HIGH. Die Risiken betreffen Verfügbarkeit (Lockout),
den Inhalt des Schreibprotokolls, fehlende Tests und veraltete Governance-Dokumente.

## Nachweise

| Prüfung | Ergebnis |
|---|---|
| `npx tsc -b --force` | exit 0 |
| `npx vitest run` | 27 Dateien, 711/711 |
| `npm run typecheck:governance` | exit 0 |
| `node ai-company/scripts/secret-scan.mjs` | 146 Dateien, 0 Funde |
| `npm audit --omit=dev --audit-level=high` | **rot** (vite als Produktionsabhängigkeit; vorbestehend, nicht durch #41; in `security.md` bereits als rot geführt) |
| Gate-Dateien | `tests/finance-policy.test.ts`, `tests/governance.test.ts`, `.claude/`, `ai-company/`, `.github/`, `CODEOWNERS` von #41 unberührt |
| Live (`get-server-info`, read-only) | Build `883b572`, Stufen `read`+`drafts`, 47 Tools, genau 1 schreibfähig (`update-voucher`), Allowlist `[update-voucher]`, `updateVoucherUncheckedOnly=true`, Protokoll `stdout-jsonl-hash-chain`, Auth `static` |
| Sonden Security | 26 Unit-Sonden grün (Status-Varianten, Allowlist, Protokollinhalt, Lockout) |
| Mutationen Code-Review | 15 erkannt, **7 überlebt** (siehe Befund C3) |

## Was bestätigt ist

- Die Allowlist greift bei der Registrierung für jedes Schreib-Tool der Stufen `drafts` und `finalize`; sie kann
  keine abgeschaltete Stufe wieder öffnen. Die Lesestufe ist nicht betroffen.
- `update-voucher` liest den Beleg im selben Aufruf unmittelbar vor dem PUT; nur der exakte Status `unchecked`
  wird akzeptiert. Fehlender Status, andere Schreibweise oder ein fehlgeschlagener GET → kein Schreibvorgang.
- Token-Vergleich bleibt zeitkonstant; der Lockout zählt nur Fehlversuche; Speicher ist begrenzt.
- Das Protokoll enthält weder Token noch Kontaktnamen oder Bemerkungen im Klartext; die Debug-Zeile ist auf
  `LEXWARE_DEBUG_LOGGING=true` beschränkt.
- Kein Agent hat `update-voucher`; `settings.json`, Guard-Hook und `governance.test.ts` sperren es weiterhin.

## Befunde

| ID | Schwere | Befund | Stelle | Empfehlung |
|---|---|---|---|---|
| S1 / C1 | MEDIUM | Der Lockout wird **vor** dem Token-Vergleich geprüft und ist auf die rechteste `X-Forwarded-For`-Adresse geschlüsselt, also auf die Egress-IP. Der claude.ai-Connector kommt aus einem geteilten Egress-Pool: Wer die öffentliche URL mit falschem Token als Connector einträgt, sperrt den echten Connector für 15 Minuten, beliebig wiederholbar – inklusive aller Lese-Tools. | `src/auth.ts:17-24, 56-61` | Entscheidung **E-1**: (a) hinnehmen und Alarm auf die Lockout-Zeile; (b) gültiges Token vom 429 ausnehmen; (c) Schlüssel = IP + kurzer Hash-Präfix des präsentierten Tokens. Empfehlung: (b) oder (c). |
| S2 / C2 | MEDIUM | `X-Forwarded-For` wird ohne Trust-Proxy-Schalter vertraut. Außerhalb von Render (docker-compose, lokal) ist der Header angreifbar: rotierend → Lockout umgangen; gezielt → fremdes Opfer gesperrt; 10 000 Werte → `clear()` löscht aktive Sperren. Fallback „unknown“ teilt sich ein Schlüssel. | `src/auth.ts:56-61, 90-104` | `TRUST_PROXY`-Flag (Default aus → `socket.remoteAddress`), IPv6 auf /64 normieren, gesperrte Einträge nie durch `clear()` verwerfen. |
| S3 | MEDIUM | Das Schreibprotokoll ist nicht geschäftsdatenfrei: Beleg-ID, Belegnummer, Datum, Beträge, Kontakt-ID, Kategorie-ID im Klartext; Namens-Fingerprints sind ungesalzene SHA-256-Präfixe (per Lieferantenliste rückrechenbar); Lexware-Fehlertext wird wörtlich übernommen; die Hash-Kette ist schlüssellos und startet je Prozess neu. Das betrifft Render-Logs, nicht das Repo. | `src/write-audit.ts:45-48, 51-74, 98-141` | HMAC mit Deployment-Geheimnis für Fingerprints und Kette; Fehler auf Statuscode/Quelle kürzen; Belegnummer fingerprinten; Formulierung „ohne PII“ → „pseudonymisiert“. |
| S4 | MEDIUM | Guard und Policy-Test vertrauen der Annotation `readOnlyHint`. Ein künftig falsch annotiertes Schreib-Tool umginge Allowlist und Protokoll unbemerkt. Heute existiert kein solches Tool. | `src/tools/write-guard.ts:47`, `tests/finance-policy.test.ts:107` | Struktur-Test: jedes Modul mit Client-Schreibmethode registriert über `writeServer` und nie mit `readOnlyHint: true`. |
| S5 | MEDIUM (Governance) | Produktiver Lexware-Write ist in der Governance nicht abgebildet: Hard Rules („Phase 1 verbietet Lexware-Writes“), `finance-write-gates.md` („keine produktiven Writes“, „16 Tools, verifiziert 06.10.“), `security.md` („serverseitige Einschränkung fehlt“), `org.json` (`phase: foundation`), README ohne die neuen Variablen. Die geforderte Entscheidung ist durch den Owner-Merge gegeben, aber nicht als Entscheidung dokumentiert. Die gehärtete Produktionskonfiguration ist durch keinen Test eingefroren. | `ai-company/policies/*`, `.claude/rules/*`, `tests/finance-policy.test.ts:54` | ADR „Phase-1-Ausnahme `update-voucher`“; Policies und `org.json` nachziehen; zweiten `PRODUCTION`-Block (Allowlist `[update-voucher]`, unchecked-only) im Policy-Test; README ergänzen. |
| C3 | MEDIUM (Tests) | 7 Mutationen überleben: Statusprüfung nur gegen `open` getestet; Finalize-Stufe ungetestet unter Allowlist; Lockout-Defaults (10 / 15 min) und Fensterreset ungetestet; Allowlist-Warnung ungetestet; Groß-/Kleinschreibung in `parseToolList` ungetestet. | `tests/write-guard.test.ts` | Tests ergänzen (Liste im Code-Review). |
| S6 | LOW | Allowlist ungesetzt + `drafts` an = alle 16 Schreib-Tools, nur mit Warnung. Nach den Hard Rules wäre `none` der fail-closed-Default; Rückwärtskompatibilität für andere Nutzer des Open-Source-Servers spricht dagegen. | `src/config.ts:284-292` | Entscheidung **E-2**. |
| S7 / C5 | LOW | Unbekannter, aber wohlgeformter Allowlist-Eintrag (Tippfehler) ergibt still 0 Schreib-Tools; `none,update-voucher` behandelt `none` als Toolname. | `src/config.ts:98-112` | Startabbruch oder Error-Log, wenn ein Eintrag kein Tool trifft; `none` nur allein zulassen. |
| S8 / C4 | LOW | Protokollzeile erst nach dem Write; Absturz oder Sink-Fehler dazwischen → Write ohne Zeile, und ein Sink-Fehler meldet einen erfolgreichen Write als Fehler (Retry-Risiko bei nicht-idempotentem POST). | `src/write-audit.ts:98-113, 139` | Sink in try/catch (nie den Aufruf scheitern lassen); „intent“-Zeile vor dem Lexware-Aufruf. |
| C6 | NIT | `target` nur aus Eingabefeld `id`; Fehlerzähler wird bei Erfolg nicht zurückgesetzt. | `write-guard.ts:49`, `auth.ts:97-104` | dokumentieren oder anpassen |
| S9 | INFO (Bedrohungsmodell) | Mit der Produktionskonfiguration kann ein Token-Inhaber bei einem Beleg mit Status `unchecked` in **einem** Aufruf jedes Feld ändern: Status (freier String, `open` = buchen), Nummer, Datum, Beträge, Steuerart, Kontakt, Bemerkung, Positionen inkl. Kategorie, Dateien (`files: []` löst den Beleg vom Dokument). Danach ist der Beleg gesperrt. Der GET→PUT-Wettlauf ist nur durch Lexwares `version`-Prüfung geschützt (offline nicht prüfbar). | `src/tools/schemas.ts:390-469`, `vouchers.ts:64-94` | zur Kenntnis; ggf. Feldliste für `update-voucher` einschränken (Entscheidung **E-3**). |

## Nicht geprüft

- Render-Verhalten bei `X-Forwarded-For` (anhängen vs. ersetzen); ob claude.ai-Egress-IPs mandantenübergreifend geteilt sind.
- Lexwares optimistisches Sperren (409 bei veralteter `version`) auf `PUT /v1/vouchers`.
- `src/server.ts` zur Laufzeit (startet beim Import); Debug-Gate und Auth-Verkabelung nur strukturell geprüft.
- CodeQL-Befunde aus der Commit-Nachricht; CI-Historie.

## Entscheidungen für Luigi

| # | Frage | Empfehlung |
|---|---|---|
| E-1 | Lockout-Verhalten (S1): hinnehmen, gültiges Token ausnehmen, oder Schlüssel um Token-Präfix erweitern? | (b) oder (c); dazu `TRUST_PROXY`-Flag (S2) |
| E-2 | Default bei ungesetzter Allowlist: alle Schreib-Tools (heute) oder `none` (fail closed)? | `none`, mit Hinweis im CHANGELOG |
| E-3 | Soll `update-voucher` in Produktion alle Felder ändern dürfen oder nur eine Teilmenge (z. B. Status, Kategorie, Kontakt)? | Teilmenge, abhängig vom Ziel der Buchhaltungsautomatik |
| E-4 | Folge-PR „#41-Härtung“ beauftragen? Umfang: S1–S4, S7, S8, C3-Tests, Governance-Nachzug (S5). Kein Produktionsrisiko, da jede Änderung nur verengt. | ja, in dieser Reihenfolge: S3 (Protokoll) → S1/S2 (Lockout) → Tests → Governance |

Bis zur Entscheidung läuft Produktion unverändert weiter; nichts in diesem Review erfordert ein Zurückdrehen.
