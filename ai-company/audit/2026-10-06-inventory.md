# Phase A + E: Bestandsaufnahme und Connector-Inventur (06.10.2026)

Öffentliches Repo: Diese Datei enthält **keine** Geschäftsdaten wie Beträge, Lieferanten, IDs oder E-Mails.

## Repository `Lus-Pinsa/lexware-mcp` (Stand `main` = `b601a6c`)

- Fork-ähnliche Kopie des Open-Source-Projekts lexware-mcp (MIT), erweitert um den LU'S-Expense-Read-Stack.
- Commits auf `main` entstehen über das GitHub-Web-UI (Committer `web-flow`). Es gibt keinen Branch-Schutz
  (`protected: false`). Branches: `main`, `patch-1..3`.
- **GitHub Actions:** Ein Workflow `CI` existierte (`state: active`), hatte aber **0 Runs** in der
  gesamten Historie. Der erste Lauf überhaupt war PR #2 am 06.10.2026.
- **Tests auf `main`:** 7 von 135 fehlgeschlagen, alle veraltet (Tier-Listen ohne LU'S-Tools,
  `pagedResult`-Strings). Der Code war korrekt.
- **`npm audit --omit=dev --audit-level=high`:** 1 critical, 11 high, 4 moderate, 2 low, alle transitiv.
- `CODEOWNERS` zeigte auf den Upstream-Autor statt auf `@Lus-Pinsa`.
- Doku-Drift: README nannte 60 Tools (tatsächlich 65). Webhook, Queue, Reconciliation, PDF-Text und
  `LEXWARE_WEBHOOK_PUBLIC_KEY` waren nicht dokumentiert.

## lexware-mcp: Architektur (tatsächlich)

| Komponente | Datei | Hinweis |
|---|---|---|
| Einstieg, Express/Skybridge | `src/server.ts` | `/status`, `/webhooks/lexware`, `/mcp` |
| Konfiguration und Tiers | `src/config.ts` | fail-closed Auth; READ_ONLY ist harter Override; Finalize impliziert Drafts |
| Auth `/mcp` | `src/oauth.ts` (OAuth 2.1/JWKS), `src/auth.ts` (statischer Bearer) | Produktion: OAuth |
| Webhook | `src/server.ts` | RSA-SHA512 `X-Lxo-Signature`, roher Body ≤ 64 KB, 503 ohne Key, nur `voucher.created` |
| Pending Queue | `src/pending-voucher-events.ts` | RAM, dedupliziert nach `eventType:resourceId:eventDate`, ohne Größenlimit |
| Tools | `src/tools/*` | 40 read · 16 drafts · 9 finalize |
| Lexware-Client | `src/lexware/client.ts` | Rate-Limit ~2 req/s, keine Retries für nicht-idempotente POSTs |

## Connectoren

| Connector | Status | Testmethode |
|---|---|---|
| **GitHub** | **VERIFIZIERT** | GitHub-MCP: `get_me`, `list_branches`, `list_workflows`, `list_workflow_runs`, `list_pull_requests`, `create_pull_request` (PR #2), `get_job_logs`. Push über git-Proxy auf den Feature-Branch. |
| **LU'S Lexware** (Render-MCP) | **VERIFIZIERT (nur lesend)** | `get-profile` OK · `list-event-subscriptions`: genau 1 Abo `voucher.created` auf den festen Callback · `get-pending-voucher-events`: 0 Einträge · `reconcile-recent-vouchers` (seit 01.10.): 9 Belege, 9 Reconciliation-Kandidaten, nicht abgeschnitten · `get-voucher` OK · `get-voucher-file-text`: PDF erkannt, Text extrahiert, 2 Seiten, SHA-256 berechnet. **Keine Write-Tools aufgerufen.** |
| **Render** (Infrastruktur) | **BLOCKIERT** | Kein Render-Connector in der Agent-Umgebung. Direktes HTTPS zu `lus-lexware-mcp.onrender.com` wurde vom Egress-Proxy der Cloud-Umgebung abgelehnt (`CONNECT tunnel failed, 403`). Lebendigkeit ist nur **indirekt** belegt, weil der Lexware-Connector antwortet. |

## Serverseitige Tier-Grenzen (aus der Tool-Liste des Connectors abgeleitet)

- Die Session sah 56 Tools: alle 40 Read- und alle 16 Drafts-Tools, **kein** `create-finalized-*`,
  `delete-article`, `create-event-subscription` oder `delete-event-subscription`.
  Daraus folgt: `LEXWARE_ENABLE_FINALIZE=false` ist **wirksam**, `LEXWARE_ENABLE_DRAFTS=true`, `LEXWARE_READ_ONLY=false`.
- Damit sind serverseitig 15 Lexware-schreibende Tools plus `acknowledge` (nur Queue) erreichbar.
  Details und Entscheidungsvorlage: `ai-company/policies/finance-write-gates.md`.

## Beobachtungen zum Read-Stack (ohne Geschäftsdaten)

- Die Queue war leer, obwohl am selben Tag ein neuer Beleg angelegt wurde. Das ist **kein Beweis** für einen verlorenen
  Webhook. Möglich sind ein Acknowledge oder ein Restart/Spin-down des RAM-Speichers. Die Reconciliation hat ihn korrekt
  als Kandidaten ausgewiesen.
- Im Abgleichsfenster gibt es Belege mit identischer Lieferanten-Rechnungsnummer, also einen fachlichen Dubletten-Verdacht.
  Die Prüfung gehört in Phase 2 (Finance). Hier wurde nichts verändert.

## Umgebung (für Reproduzierbarkeit)

- Lokale Gates: Node 22 im Container, CI läuft auf Node 24 (`engines` ≥ 24.14.1).
- Netzwerk der Cloud-Umgebung blockiert u. a.: `onrender.com`, `github.blog`, `docs.github.com`,
  `render.com`, `developers.lexware.io`, `modelcontextprotocol.io`.
