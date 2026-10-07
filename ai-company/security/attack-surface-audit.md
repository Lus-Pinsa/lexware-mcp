# Attack Surface Audit: Befunde

Stand: Security Architecture Gate. Basis `main` = `8f938aa`. Die Fixes stehen auf dem Branch dieses PRs.
Quellen:
- Security Architect (`SAG-xx`): Code-, Konfigurations- und lokale Proben gegen `src` und `dist` mit Dummy-Secrets und einem Mock-Lexware auf localhost.
- Supply-Chain-Reviewer (`SUP-xx`): npm, Actions, Ruleset, Docker, Render.
- History-Analyst: siehe `history-exposure.md`.

Es gab keine Angriffe gegen fremde oder produktive Infrastruktur. Live wurde nur `get-server-info` gelesen (lokal, ohne Lexware-Aufruf).

**Status:**
- **FIXED:** in diesem PR behoben, mit Test.
- **OWNER:** Owner-/Infrastruktur-Aktion (siehe `README.md`).
- **DECISION:** Owner-Entscheidung nötig.
- **FUTURE:** Vertrag oder Folge-PR.
- **ACCEPTED:** dokumentiertes Restrisiko.

## Zusammenfassung

| Schweregrad | Anzahl | davon FIXED | offen |
|---|---|---|---|
| CRITICAL | 0 | – | – |
| HIGH | 1 (SUP-01) | 0 | 1: OWNER (Ruleset) |
| MEDIUM | 11 (SAG-15 und SUP-05 zusammengefasst) | 6: SAG-03, SAG-04 (Fehlertexte; Rest FUTURE), SAG-07, SUP-05, SUP-06, SUP-07 | 5: SAG-02 DECISION, SAG-06 FUTURE, SUP-02/03/04 OWNER |
| LOW | 20 (ohne Doppelnennungen SAG-16/17) | 9: SAG-05, SAG-08 (Warnung), SAG-10, SAG-11, SAG-12 (teilweise), SAG-14, SUP-08, SUP-13, HIST-F2 | 11: OWNER, DECISION oder ACCEPTED |
| INFO | 6 | – | dokumentiert |

> SAG-01 des Architekten (bedingt HIGH: „Ruleset möglicherweise nicht aktiv“) ist durch Live-Lesung **widerlegt**: Das Ruleset `main-protection` ist aktiv (PR-Pflicht, kein Force-Push, keine Löschung). Der verbleibende Kern ist SUP-01.

## Befunde

| ID | Sev. | Komponente | Befund (Nachweis) | Status / Maßnahme |
|---|---|---|---|---|
| **SUP-01** | **HIGH** | GitHub Ruleset | CodeQL (`analyze`), `audit (production dependencies)` und `dependency-review` laufen, sind aber **keine Pflicht-Checks**. Es gibt keine `code_scanning`-Regel und keine `integration_id`. „Kein Merge bei CRITICAL/HIGH“ ist damit serverseitig nicht erzwungen. Nachweis: Ruleset 24603540 live. | **OWNER**: Ruleset-JSON und UI-Pfad in `README.md` (O-1). Soll-JSON: `ai-company/github/ruleset-main.json`. |
| SAG-02 | MEDIUM | Tiers (`config.ts`) | Ohne `LEXWARE_READ_ONLY` oder mit leerem Wert gilt „Drafts an“, also 16 Write-Tools. Produktion ist verifiziert read-only, hängt aber an einer Env-Variable. | **DECISION** (Änderung der Read-only-Grenze, darum HARD STOP für Agents): Standard „read-only“ oder Start-Guard. Bis dahin: Kontrolle über `get-server-info` nach jedem Deploy (O-7). |
| SAG-03 | MEDIUM | Webhook | Keine Bindung an die `organizationId`. Probe: fremde Org ergab 204 und wurde eingereiht. | **FIXED**: `src/lexware/webhook.ts` (`evaluateLexwareWebhook`), optionale Variable `LEXWARE_ORGANIZATION_ID`, Startwarnung, `get-server-info.webhook.organizationBindingConfigured`. Tests: `tests/webhook.test.ts`, `tests/config.test.ts`, `tests/server-info.test.ts`. Wirksam nach **OWNER** O-4. |
| SAG-04 | MEDIUM | Fremdtext in Ausgaben | Lexware-Fehlertexte (die Eingaben Dritter spiegeln können) gingen roh an das Modell. Klassische Read-Tools liefern rohes Upstream-JSON. | **FIXED** (Fehlertexte): `src/lexware/errors.ts` bereinigt mit `cleanUntrustedText` (Steuerzeichen, Markup, URLs, Zeilenumbrüche; Cap 4000). Tests in `tests/errors.test.ts`. **FUTURE** (strukturierte Read-Ergebnisse): gemeinsame Ausgabe-Schicht. |
| SAG-05 | LOW | Downloads | `download-file`, `render-*-pdf`, `get-document-file` und `get-voucher-file` ohne Größen-Cap. Probe: 200 MiB ergaben eine Antwort mit 279 MB und RSS von etwa 1,2 GB. | **FIXED**: `MAX_DOWNLOAD_BYTES` = 15 MiB an allen 4 Aufrufstellen. Test in `tests/write-tools.test.ts`. |
| SAG-06 | MEDIUM | PDF-Parser | Der Worker-Thread ist keine Sicherheitsgrenze: `/proc/self/environ` ist lesbar, `child_process` ist verfügbar. | **FUTURE**: Kindprozess ohne Secrets oder Node-Permission-Model. Mitigiert durch Caps und `isEvalSupported: false`. |
| SAG-07 | MEDIUM | OAuth | Ohne Allowlist wurde jeder IdP-Nutzer akzeptiert (nur WARNING). In Produktion nicht aktiv. | **FIXED**: Start wird verweigert, außer `OAUTH_ALLOW_ANY_USER=true`. Tests in `tests/config.test.ts`. |
| SAG-08 | LOW | Static Bearer | Mindestens 16 Zeichen, keine Entropieprüfung, gemeinsames Secret. | **FIXED** (Warnung unter 32 Zeichen). Eine harte Grenze würde die Produktion bei kürzerem Token stoppen, daher **OWNER** O-6 (Token prüfen, rotieren). **FUTURE**: Identität je Client. |
| SAG-09 | LOW | Inbound-Last | Kein Rate- oder Concurrency-Limit je Token; die Lexware-Quote (2 Requests/s) wird geteilt. | **FUTURE** |
| SAG-10 | LOW | Logs | Pre-Auth-Debug-Zeile mit User-Agent und Accept bei jedem Request. Webhook-Felder ungeprüft im Log (Log-Forging). | **FIXED**: Pre-Auth-Zeile nur noch mit Methode, Pfad (JSON-quotiert) und Auth-Flag; Webhook-Logs nur mit validierten Feldern; fremde Org-IDs werden nicht geloggt. Rest: Skybridge loggt fehlerhafte JSON-Bodies authentifizierter Aufrufer (**ACCEPTED**, LOW). |
| SAG-11 | LOW | Webhook-Robustheit | Ein signierter `null`-Body ergab 500. Nicht-String-`resourceId` wurde gespeichert, 60-KB-`resourceId` eingereiht. Die Queue war unbegrenzt. | **FIXED**: Shape- und Längenprüfung (400 mit fester Begründung), `MAX_PENDING_VOUCHER_EVENTS` = 1000 mit Verwerfen der ältesten Events. Tests in `tests/webhook.test.ts`. |
| SAG-12 | LOW | HTTP | `X-Powered-By: Express`; keine Host- oder Origin-Prüfung (DNS-Rebinding braucht das Token). | **FIXED** (`x-powered-by` aus). Host-Allowlist: **FUTURE** (relevant nur ohne Auth). HSTS: Render (DATA NOT AVAILABLE). |
| SAG-13 | LOW | Lexware-Client | Redirects werden gefolgt (Authorization wird cross-origin entfernt). Nicht-Netzwerk-TypeErrors werden wiederholt. | **ACCEPTED**: Ob Lexware-Downloads umleiten, ist nicht verifizierbar; `redirect: "error"` könnte Downloads brechen. |
| SAG-14 | LOW | Telemetrie | skybridge sendet bei jedem Tool-Aufruf UDP an eine feste IP. | **FIXED**: `SKYBRIDGE_TELEMETRY_DISABLED=1` und `DO_NOT_TRACK=1` im Image. **OWNER** O-8, falls Render nicht aus dem Dockerfile baut. |
| SAG-15 / SUP-05 | MEDIUM | Laufzeit | Produktion lief auf Node 26 (Current, nicht LTS), CI testet auf Node 24. | **FIXED**: `node:24-slim` per Digest; Dependabot ohne automatische Node-Major-Sprünge. |
| SUP-08 | LOW | Docker | Basis-Image nicht per Digest gepinnt | **FIXED** |
| SUP-06 | MEDIUM | Telemetrie | wie SAG-14 | **FIXED** |
| SUP-07 | MEDIUM | Secret-Scan | Lücken: Render-Deploy-Hooks, Google-, Stripe- und npm-Tokens, Credentials in URLs, Bearer-Literale, künftige DB- und Verschlüsselungs-Secrets | **FIXED**: 7 neue Regeln. Tests in `tests/governance.test.ts` (Gegenprobe: 7 Tests rot mit altem Scanner). Rest: Beträge und Zeitstempel sind nicht automatisch erkennbar (**FUTURE**: Fixture-Regel, siehe `history-exposure.md`). |
| SUP-02 | MEDIUM | Actions | keine SHA-Pins; `dependency-review-action@v4` ist ein Branch | **OWNER** O-5 (Workflows sind Gate-Dateien; Pinning-Tabelle in `supply-chain-and-platform.md`) |
| SUP-03 | MEDIUM | Governance | Ruleset und Merge hängen an einer Identität; die Agent-Identität hat Admin-Leserechte über den Proxy | **OWNER** O-2 (Token-Scopes, 2FA) |
| SUP-04 | MEDIUM | Dependabot | Security-Updates aus, monatlich, gruppierte Majors | **OWNER** O-3; Node-Major-Ignore ist **FIXED** |
| SUP-09 | LOW | npm | esbuild-Low-Advisory unter skybridge | **ACCEPTED** (siehe `ai-company/audit/2026-10-06-dependency-audit.md`) |
| SUP-10 | LOW | Build | `npm ci` führt Install-Skripte aus (nur esbuild) | **ACCEPTED** |
| SUP-11 | LOW | Secret Scanning | Non-Provider-Patterns und Validity Checks aus | **OWNER** O-3 |
| SUP-12 | LOW | `SECURITY.md` | verweist auf Private Vulnerability Reporting, das deaktiviert ist | **OWNER** O-3 |
| SUP-13 | LOW | Doku | dokumentiertes Ruleset weicht vom Live-Stand ab | **FIXED**: `ai-company/github/ruleset-main.json` ist jetzt das Soll-Ruleset (Unterschied zum Ist dokumentiert) |
| SUP-14 | LOW | CodeQL | Workflow-Dateien (`actions`) werden nicht gescannt | **OWNER** O-5 |
| SUP-15 | LOW | Repo | alte Branches; Rebase-Merge erlaubt | **OWNER** O-9 |
| SUP-16 | LOW | Tags | kein Tag-Ruleset | **OWNER** O-1 |
| HIST-1 | LOW | Git-Historie | reale Beträge und Zeitstempel in der öffentlichen Historie, auch über das Fork-Netzwerk erreichbar | **DECISION** (`history-exposure.md`, Empfehlung Option a) |
| HIST-R1 | LOW | Fixtures | möglicherweise echte Kalendertage in `tests/fixtures/finance-fixtures.ts` | **OWNER**/Folge-PR O-H2 |
| HIST-F2 | LOW | Doku | PR-1-Audit behauptete „nur synthetisch“ | **FIXED** (Nachtrag) |
| SAG-16 | LOW | CI | wie SUP-02/SUP-04 | siehe dort |
| SAG-17 | — | Historie | wie HIST-1 | siehe dort |
| SAG-18 | INFO | Fassade | `%252e` passiert, ohne Wirkung; https-URLs nur aus der Konfiguration | ACCEPTED |
| SAG-19 | INFO | Öffentlich | Produktions-Hostname im öffentlichen Repo; `GET /webhooks/lexware` nennt den Event-Typ | ACCEPTED |
| SAG-20 | INFO | Routing | Groß- und Kleinschreibung bei Pfaden; Parser-Erkennung über den Funktionsnamen (Warnung vorhanden) | ACCEPTED |
| SUP-17 | INFO | Fork-Netzwerk | gemeinsamer Objektspeicher; Agents müssen PRs explizit gegen `Lus-Pinsa/lexware-mcp` öffnen | dokumentiert |
| SUP-18 | INFO | Render | Dashboard nicht einsehbar | **OWNER** O-7/O-8 |
| SUP-19 | INFO | Provenance | Render baut aus Git; kein Registry-Image | dokumentiert |

## Verifizierte bestehende Controls (Auszug mit Nachweis)

1. **Auth fail closed:** Ohne Auth-Konfiguration ConfigError (`config.ts`); leeres Token fail closed; Token mit 15 Zeichen abgewiesen; alle Pfad- und Methodenproben ohne bzw. mit falschem Token ergeben 401.
2. **Konstante Vergleichszeit:** `timingSafeEqual` (`auth.ts`).
3. **Body-Parsing nach Auth:** 200 KB vor der Auth ergeben 401; Gzip-Bombe in etwa 3 ms abgewiesen.
4. **Read-only:** lokal und live 46 Tools, 0 schreibfähig; `PRODUCTION_WRITE_TOOLS` unverändert (byte-identisch zu `d238b74`).
5. **Pfadsicherheit:** 210 Fuzz-Aufrufe und 27 Fassadenpfade ohne Ausbruch.
6. **Kein SSRF:** Kein Tool nimmt eine URL. Basis-URL nur aus der Konfiguration (https oder Loopback). Das LU'S-Webhook-Tool hat eine feste URL und ist nicht im Read-Tier.
7. **Webhook-Signatur:** RSA-SHA512 über den Roh-Body vor dem Parsen; 503, 401 bzw. 413 wie erwartet.
8. **OAuth-Verifier:** alle 18 Token-Fälle korrekt.
9. **Secrets:** Kein Secret im Server-Log, in `get-server-info` oder in Ausgaben. Der Worker läuft mit leerer Umgebung. Der Secret-Scan über alle Refs ist sauber (für seine Regeln).
10. **PDF-Caps:** Byte-, Seiten-, Zeit-, Speicher- und Concurrency-Grenzen, jeweils fail closed.
11. **CI:** Least-Privilege-Token, `persist-credentials: false`, kein `pull_request_target`, Lockfile nur aus der npm-Registry mit Integrity.
