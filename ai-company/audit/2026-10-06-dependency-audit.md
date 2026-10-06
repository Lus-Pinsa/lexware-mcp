# Dependency-Hardening: Analyse je Advisory (06.10.2026)

Branch `claude/dependency-hardening`. Er baut auf PR #2 auf, `main` bleibt unverändert.
Ausgangslage: `npm audit --omit=dev` meldete **18 Befunde (1 critical, 11 high, 4 moderate, 2 low)**, alle transitiv.
PR #2 hatte den Lockfile nicht verändert.

## Vorgehen (kein `npm audit fix --force`)

1. `npm update <betroffene Pakete>`: nur semver-kompatible Updates innerhalb der Ranges der Eltern-Pakete.
2. Für die einzige Kette ohne Patch (`braces`) gibt es einen **gezielten** Override, nur für nodemon:
   `"overrides": { "nodemon": { "chokidar": "^4.0.3" } }`. chokidar 4 braucht `braces` nicht mehr.
3. **Laufzeit-Nachweis**: Der gebaute Server (`node dist/server.js`) wurde mit einem Modul-Lade-Tracer gestartet
   (ESM-Load-Hook plus CommonJS-`Module._load`). Danach liefen `GET /status`, `GET /webhooks/lexware`, ein
   nicht authentifizierter `POST /mcp` (401), `initialize` und `tools/list` (56 Tools). Der Lauf erfolgte einmal mit
   `NODE_ENV=production` und einmal ohne.

## Ergebnis je Paket

| Paket | Schwere | Pfad | Zur Laufzeit geladen? | Vorher → nachher | Status |
|---|---|---|---|---|---|
| proxy-addr | **critical** | express ← MCP-SDK, skybridge | **ja** | 2.0.7 → 2.0.8 | **behoben** |
| qs | moderate | express | **ja** | 6.15.2 → 6.16.0 | **behoben** |
| body-parser | low | express | **ja** | 2.2.2 → 2.3.0 | **behoben** |
| fast-uri | high | ajv ← MCP-SDK | **ja** | 3.1.2 → 3.1.8 | **behoben** |
| ip-address | high | express-rate-limit ← MCP-SDK | **ja** | 10.2.0 → 10.7.3 | **behoben** |
| @hono/node-server | moderate | MCP-SDK | **ja** | 1.19.14 → 1.19.17 | **behoben** |
| hono | moderate | MCP-SDK | nein | 4.12.27 → 4.13.13 | **behoben** |
| nanoid | high | postcss ← vite | nein | 3.3.15 → 3.3.20 | **behoben** |
| postcss | high | vite | nein | 8.5.16 → 8.5.29 | **behoben** |
| source-map-js | high | postcss ← vite | nein | 1.2.1 → 1.2.2 | **behoben** |
| browserslist | high | @babel/core ← skybridge | nein | 4.28.2 → 4.29.3 | **behoben** |
| baseline-browser-mapping | moderate | browserslist | nein | 2.10.33 → 2.11.27 | **behoben** |
| brace-expansion | high | minimatch ← @oclif/core ← skybridge | nein | 5.0.6 → 5.0.12, 2.1.1 → 2.1.7 | **behoben** |
| braces | high | chokidar@3 ← nodemon (Peer von skybridge, nur für `skybridge dev`) | nein | 3.0.3 → entfernt | **behoben** (Override) |
| chokidar | high | nodemon | nein | 3.6.0 → 4.0.3 | **behoben** (Override) |
| nodemon | high | Peer von skybridge | nein | 3.1.14 (mit chokidar 4) | **behoben** (Override) |
| skybridge | high (nur über nodemon) | direkt | ja (Framework) | 1.2.4 unverändert | **behoben** (über Override) |
| esbuild | low | in skybridge verschachtelt, 0.27.7 | nein | unverändert | **offen, low**: Advisory GHSA-g7r4-m6w7-qqqr betrifft laut Text nur den *Dev-Server unter Windows*. Fix erst mit skybridge ≥ 1.3 (eigenes Minor-Upgrade, separat zu bewerten). |

Danach: `npm audit --omit=dev --audit-level=high` mit **exit 0**, verbleibend **1 low** (esbuild, s. o.).

**Keine Schwachstelle wurde allein durch Behauptung als irrelevant eingestuft.** Alle zur Laufzeit geladenen Pakete
sind auf gepatchte Versionen aktualisiert. Nicht geladene Pakete sind ebenfalls aktualisiert, mit Ausnahme von
esbuild (low, Windows-Dev-Server).

## Prüfung der Auswirkungen

| Bereich | Prüfung | Ergebnis |
|---|---|---|
| Laufzeit / MCP-Verhalten | Server-Start, `initialize`, `tools/list` mit 56 Tools (= Produktions-Tiers), 401 ohne Token | ✅ |
| Breaking Changes | alle Updates Patch/Minor innerhalb der Eltern-Ranges; chokidar 4 nur über nodemon (Dev) | ✅ |
| Skybridge-Kompatibilität | skybridge 1.2.4 unverändert; `skybridge dev` startet, `/status` 200, Neustart bei Dateiänderung („restarted due to file change“) | ✅ |
| nodemon mit chokidar 4 | Funktionstest: Neustart nur für `src/*.ts`, kein Neustart außerhalb von `src` oder bei falscher Endung | ✅ |
| OAuth | `tests/oauth.test.ts` (jose unverändert 6.2.3) | ✅ |
| Lexware-Read-Pipeline | `tests/finance-policy.test.ts`, Webhook-Route unverändert; Server lädt `pdf-parse`/`pdfjs-dist` | ✅ |
| Tests / Build / Governance | `npm ci`, `npm run build`, `npm run typecheck:governance`, `npm test` (221/221), `secret-scan` | ✅ |
| Docker | lokal kein Docker-Daemon verfügbar; Nachweis über CI-Job `docker` | in CI |

## Nebenbefunde aus der Laufzeit-Analyse (nicht in diesem PR geändert)

1. **`NODE_ENV` muss `production` sein.** Ohne diese Variable lädt skybridge `vite` zur Laufzeit (Dev-Modus).
   Das Dockerfile setzt `NODE_ENV=production`. Auf Render prüfen, ob der Dienst per Docker läuft oder die Variable gesetzt ist.
2. **skybridge-Telemetrie:** Der Server sendet bei jedem `tools/call` einen UDP-Zähler
   (`Requests:1|c|#version:<major.minor>`) an einen externen StatsD-Host (`node_modules/skybridge/dist/server/metric.js`).
   Laut Code enthält er keine Geschäftsdaten. Er ist standardmäßig aktiv und lässt sich mit `SKYBRIDGE_TELEMETRY_DISABLED=1`
   (oder `DO_NOT_TRACK=1`) abschalten. Empfehlung: auf Render abschalten (Owner-Aktion).
