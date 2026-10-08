# Threat Model (STRIDE)

Stand: Security Architecture Gate, Basis `main` = `8f938aa`. Erstellt vom Security Architect (unabhängig, nur lesend, lokale Proben); konsolidiert vom Implementer.
Methode: STRIDE (**S**poofing, **T**ampering, **R**epudiation, **I**nformation Disclosure, **D**enial of Service, **E**levation of Privilege) je Komponente und Datenfluss.
Belege stehen als Datei:Zeile; die Befund-IDs (`SAG-xx`, `SUP-xx`) sind in `attack-surface-audit.md` beschrieben.

## 1. Assets

| Asset | Klasse | Warum kritisch |
|---|---|---|
| `LEXWARE_API_KEY` | SECRET | Voller Zugriff auf die Lexware-Organisation über die Public API, **auch schreibend**. Die Read-only-Grenze des Servers gilt nur für den Server, nicht für den Schlüssel. |
| `MCP_AUTH_TOKEN` | SECRET | Zugang zu allen registrierten Tools (heute: 46 Read-Tools) |
| Buchhaltungsdaten (Belege, Rechnungen, Kontakte, PDFs) | FINANCIAL, PERSONAL DATA | Vertraulichkeit; DSGVO |
| Integrität des ausgelieferten Codes | — | Wer `main` oder Render kontrolliert, kontrolliert den Server samt Secrets |
| Webhook-Public-Key | INTERNAL | Wird er manipuliert, werden gefälschte Webhooks angenommen |
| Ruleset und CI-Gates | — | verhindern ungeprüften Code auf `main` |

## 2. Angreifer

| ID | Angreifer |
|---|---|
| A1 | anonym aus dem Internet |
| A2 | Inhaber eines geleakten MCP-Tokens |
| A3 | bösartiger Inhalt in Lexware-Dokumenten (PDF-Text, Belegfelder, Lieferantennamen): Prompt-Injection |
| A4 | kompromittierte Abhängigkeit (npm, Docker-Image, GitHub Action) |
| A5 | kompromittiertes GitHub-Konto oder kompromittierte Action |
| A6 | kompromittiertes Render-Konto |
| A7 | bösartiger oder fehlgeleiteter AI-Client bzw. Agent |
| A8 | anderer Lexware-Kunde, der seine Organisation auf unsere öffentliche Webhook-URL abonniert |

## 3. Trust Boundaries und Datenflüsse

```
Internet ──TLS (Render-Edge)──► Node-Prozess (server.ts)
   │                               ├─ /mcp ──► Auth (Bearer | OAuth) ──► Tool-Registry (Tiers) ──► Lexware-Client ──TLS──► api.lexware.io
   │                               │                                         └─ Finance/Datei-Text: GET-only-Fassade (Allowlist)
   │                               ├─ /webhooks/lexware ──► RSA-SHA512-Signatur ──► Validierung + Org-Bindung ──► RAM-Queue (≤ 1000)
   │                               ├─ /status (minimal)
   │                               └─ PDF-Parser (Worker-Thread im selben Prozess)
GitHub (main, Ruleset, Actions) ──Auto-Deploy?──► Render (Env-Secrets) ──► Node-Prozess
Claude/Agents ──MCP──► /mcp           Lexware-Dokumente (Dritt-Inhalt) ──► Tool-Ausgaben ──► AI-Kontext
```

Grenzen:
- **TB1:** Internet zu Server
- **TB2:** Auth zu Tools
- **TB3:** Server zu Lexware
- **TB4:** Fremdinhalt zu AI-Kontext
- **TB5:** Parser zu Prozess
- **TB6:** GitHub zu Render
- **TB7:** Render zu Secrets

## 4. STRIDE je Komponente

| # | Komponente / Entry Points | Bedrohungen (STRIDE) und Abuse Cases | Bestehende Controls | Fehlende Controls / Blast Radius |
|---|---|---|---|---|
| 1 | **Internet → Server** (`/mcp`, `/webhooks/lexware`, `/status`, `/.well-known/*` bei OAuth) | **S:** gefälschter Webhook (A1, A8). **T:** manipulierte Bodies. **D:** große oder komprimierte Bodies, Log-Flut. **E:** Auth-Bypass über Pfad-Tricks. | Body-Parsing für `/mcp` erst nach Auth (`server.ts`, `deferMcpBodyParsing`). Proben: 200 KB vor der Auth ergeben 401; Gzip-Bombe abgewiesen in etwa 3 ms; `//mcp`, `/./mcp`, `/%6dcp` ergeben 404; `/MCP` ist authentifiziert. **Neu:** `x-powered-by` abgeschaltet; Pre-Auth-Log ohne Client-Header; `/MCP` und andere Schreibweisen überspringen den Pre-Auth-Parser wie `/mcp` (ADV-5). | Kein Inbound-Rate-Limit (SAG-09). Keine Host- oder Origin-Prüfung (SAG-12, LOW, da das Token nötig ist). Blast Radius: Verfügbarkeit. |
| 2 | **Clients → MCP** (`POST /mcp`) | **S:** Das gemeinsame Token hat keine Identität (A2, A7). **R:** kein Audit je Aufrufer. **I:** Confused Deputy: Ein Schlüssel bedient alle Aufrufer, jeder Token-Inhaber liest alles. **D:** schwere Tools (`summarize-vouchers`, Finance bis 500 Requests). | `timingSafeEqual` (`auth.ts`). Tier-Filter bei der Registrierung (`tools/index.ts`). Write-Fläche eingefroren (`tests/finance-policy.test.ts`). Begrenzte Schemas. Live: 46 Tools, 0 schreibfähig. | Keine Identität und kein Audit (Multi-Tenant-Vertrag T-05/T-06, Persistence-Vertrag P-80). Blast Radius bei Token-Leak: Lesezugriff auf alle Lexware-Daten, kein Schreiben. |
| 3 | **OAuth** (`oauth.ts`, `config.ts`) | **S:** Token für eine andere Audience. **E:** IdP-Nutzer außerhalb der Allowlist (Self-Signup). | Proben: alg=none, HS256-Key-Confusion, falscher Issuer bzw. falsche Audience, abgelaufen, ohne `sub` abgewiesen; `a@allowed@evil` korrekt; nur Metadaten mit S256. **Neu:** Der Start ohne Allowlist wird verweigert, außer `OAUTH_ALLOW_ANY_USER=true` ist explizit gesetzt (SAG-07). | Keine Scope- oder Client-Allowlist (FUTURE). In Produktion nicht aktiv (`auth.mode = static`). |
| 4 | **Lexware-Client** (`lexware/client.ts`) | **T:** MITM (nur TLS). **E:** Pfad-Injection, SSRF, Header-Injection. **I:** Echo von Fehlertexten. **D:** große Antworten. | Basis-URL nur aus der Konfiguration, https oder Loopback. `assertSafeRequestPath` und `encodeURIComponent`. Fuzz: 210 Aufrufe blieben unter `/v1/<resource>`. **Neu:** Upstream-Fehlertexte werden bereinigt (SAG-04); 15-MiB-Cap für Binär-Downloads (SAG-05). | **Neu:** Redirects nur innerhalb des Lexware-Origins und nur für GET (SAG-13); API-Schlüssel wird aus Fehlertexten geschwärzt (ADV-6). Offen: JSON-Antworten ohne Größen-Cap (LOW). |
| 5 | **Webhooks** (`server.ts`, `lexware/webhook.ts`, `pending-voucher-events.ts`) | **S:** Ein anderer Lexware-Mandant abonniert unsere URL (A8): Die Signatur ist gültig, aber für eine fremde Organisation. **T:** Replay. **D:** Queue-Wachstum, Log-Injection über signierte Felder. | RSA-SHA512 über den Roh-Body vor dem Parsen; 503 ohne Schlüssel, 401 ohne bzw. mit falscher Signatur; 64 KB; Dedupe. **Neu:** testbares Modul `src/webhook-receiver.ts`; Shape-, Typ- und Längenprüfung je Feld; Org-Bindung über `LEXWARE_ORGANIZATION_ID`; Queue auf 1000 begrenzt, Überlauf gemeldet; Logs ohne Lexware-IDs (SAG-03, SAG-10, SAG-11, AUD-2/3). | Die Org-Bindung wirkt erst, wenn der Owner die Variable setzt (Owner-Aktion). Kein Zeitfenster gegen Replay alter Events (LOW; Dedupe greift, solange das Event in der Queue ist). |
| 6 | **Render-Laufzeit** | **I/E (A6):** Env lesen heißt alle Secrets lesen; beliebigen Code deployen. **S:** `LEXWARE_API_BASE_URL` umbiegen. **D:** Neustart leert die Queue. | Nicht-root-User; `.dockerignore`; **neu:** Image per Digest gepinnt, Node 24 LTS, Telemetrie aus (SUP-05/06/08). | Render-Dashboard: DATA NOT AVAILABLE. Blast Radius A6: total (Lexware-Schlüssel mit Schreibrecht). |
| 7 | **GitHub / Actions** | **T (A5):** bösartiger Push oder PR mit anschließendem Deploy. **I:** öffentliche Historie (siehe `history-exposure.md`). **E:** Workflow mit Rechten. | Ruleset: PR-Pflicht, kein Force-Push, keine Löschung, 2 Pflicht-Checks. CI mit `contents: read`, `persist-credentials: false`, ohne `pull_request_target`. Secret Scanning und Push Protection an. | CodeQL, Audit und dependency-review sind keine Pflicht-Checks; keine Code-Scanning-Regel (**SUP-01, HIGH**). Actions nicht SHA-gepinnt (SUP-02). Ein-Personen-Kontrolle (SUP-03). |
| 8 | **Env-Secrets** (`config.ts`) | **I:** Leak über Logs, Fehler, Tool-Ausgaben. **T:** leere Werte. | `get-server-info` liefert nur Präsenz-Flags; ConfigError ohne Secret; Token ≥ 16 Zeichen, **neu** mit Warnung unter 32; PDF-Worker mit `env: {}`; Log-Grep ohne Treffer. | Ein leeres `LEXWARE_READ_ONLY` fällt auf „Drafts an“ zurück (**SAG-02, MEDIUM**, Owner-Entscheidung). Der Worker kann `/proc/self/environ` lesen (SAG-06). |
| 9 | **PDF-Download/Parser** (`file-inspection.ts`) | **D:** Kompressionsbombe, Riesendatei. **E:** Parser-RCE (A3, A4). **T:** Prompt-Injection. | 10 MiB beim Streamen, 15 s, 20 Seiten, 200 000 Zeichen, Heap 256 MB, RSS-Watchdog, ein Parser-Slot, `isEvalSupported: false`, Nonce-Block mit Bereinigung. | Ein Worker-Thread ist **keine** Sicherheitsgrenze (SAG-06, MEDIUM, FUTURE: Kindprozess ohne Secrets). |
| 10 | **Finance-Loader und Read-only-Fassade** | **E:** Schreibpfad aus Finance-Tools. **T:** doppelt kodierte Traversal. **D:** Request-Verstärkung. | Eingefrorene Fassade nur mit `get`/`getBinary`; Allowlist; Budget (Standard 150, max. 500 pro Tool). | `%252e` passiert die Fassade, ist aber ohne Wirkung, solange der Upstream nicht doppelt dekodiert (INFO). |
| 11 | **Tool-Registrierung und Tiers** | **E:** Write-Tools erreichbar. | READ_ONLY überstimmt alles; Finalize nur mit Drafts; Policy-Tests. Live verifiziert: Tiers `["read"]`. | Der Standard ohne Variablen ist „Drafts an“ (SAG-02). `writeCapable` beruht auf Annotationen; die Tests sind die eigentliche Kontrolle. |
| 12 | **Logs und Fehler** | **I:** PII oder Secrets im Log. **T:** Log-Injection, Injection über Fehlertext. | Fehlertext gekappt; **neu:** Fehlertexte bereinigt, Webhook-Logs nur mit validierten Feldern, Pre-Auth-Log ohne User-Agent und Accept. | Skybridge loggt fehlerhafte JSON-Bodies authentifizierter Aufrufer (LOW). |
| 13 | **Künftig: Persistence, Dashboard, WhatsApp/Voice** | **S:** gefälschte Kanal-Identität. **T:** Prompt-Injection über Nachrichten. **R:** kein Audit. **I:** gespeicherte FINANCIAL- und PII-Daten. **E:** Kanal löst Writes aus; Tenant-Vermischung. | Verträge: `contracts/persistence-security-contract.md`, `contracts/multi-tenant-security-contract.md`, `contracts/voice-messaging-security-contract.md`. | Umsetzung erst mit den jeweiligen PRs; Abnahme gegen die Vertrags-IDs. |

## 5. Wichtigste Angriffspfade (nach Wirkung)

| # | Pfad | Voraussetzung | Wirkung | Status |
|---|---|---|---|---|
| P1 | Kompromittiertes GitHub-Konto → Merge auf `main` → Auto-Deploy → Code mit Zugriff auf alle Secrets | Owner-Konto oder Token mit Admin-Recht; Render-Auto-Deploy (unbekannt) | total | Ruleset verhindert direkten Push; Gates nur teilweise Pflicht (**SUP-01, HIGH**); 2FA und Token-Scopes sind Owner-Aktionen |
| P2 | Kompromittiertes Render-Konto → Env lesen → Lexware-Schlüssel | Render-Zugang | total, an MCP vorbei | Owner: 2FA, Team prüfen; IR-Plan |
| P3 | Parser-RCE durch bösartiges PDF → `/proc/self/environ` → Secrets | 0-day in pdfjs/canvas | total | Caps aktiv; Prozess-Isolation offen (SAG-06, FUTURE) |
| P4 | Leere oder verlorene Env-Variable `LEXWARE_READ_ONLY` → Write-Tools registriert | Fehlkonfiguration in Render | 16 Write-Tools live | Owner-Entscheidung (SAG-02); Erkennung über `get-server-info` |
| P5 | Geleaktes MCP-Token → alle Lesedaten | Token-Leak | Vertraulichkeit | Rotation (IR-Plan); künftig Identität und Audit |
| P6 | Fremder Lexware-Mandant → signierte Webhooks an unsere URL | Lexware-Konto; ein Signaturschlüssel für alle Mandanten (DATA NOT AVAILABLE) | falsche „neuer Beleg“-Hinweise, Queue-Flut | **behoben im Code** (Validierung, Cap, Org-Bindung); wirksam nach Owner-Aktion `LEXWARE_ORGANIZATION_ID` |
| P7 | Prompt-Injection in Lieferantentext oder Fehlertext → Agent handelt | AI-Client folgt Fremdtext | Exfiltration über Client-Tools; kein Server-Write | PDF- und Finance-Pfade umhüllt; Fehlertexte **neu** bereinigt; strukturierte Read-Ergebnisse noch roh (SAG-04 Rest, FUTURE) |

## 6. Grundsätze für künftige Änderungen

- Jede neue Komponente erhält eine Zeile in Abschnitt 4: Trust Boundary, Controls, Blast Radius.
- Credentials erhalten den kleinsten möglichen Wirkungsbereich; jede Komponente hat ihr eigenes Credential.
- Bei Fehlern und unklaren Daten: Fail closed.
- Fremdtext ist immer `untrusted`, auch nach dem Speichern.
