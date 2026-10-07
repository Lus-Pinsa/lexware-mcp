# Supply Chain, GitHub und Render: Posture, Soll/Ist, Owner-Aktionen

Stand: Security Architecture Gate, `main` = `8f938aa`. Die Prüfung war unabhängig und nur lesend. Die Befund-IDs `SUP-xx` werden in `README.md` konsolidiert.

> **Hinweis zur Prüf-Identität:** Die GitHub-API-Aufrufe dieser Session laufen über einen Proxy mit Admin-Leserechten auf das Repository. Agents haben damit technisch Sicht auf Einstellungen. Sie ändern aber **keine** Einstellungen; Ruleset- und Repo-Änderungen sind Owner-Aktionen.

## 1. npm

| Prüfung | Ergebnis |
|---|---|
| Produktionsbaum | 280 Pakete (`npm ls --all --omit=dev`) |
| Lockfile | `lockfileVersion` 3; alle 403 Einträge mit sha512-Integrity; 0 Quellen außerhalb von `registry.npmjs.org`; keine Git- oder Link-Abhängigkeiten; keine `.npmrc` |
| `npm audit --omit=dev` | 0 critical, 0 high, 0 moderate, 1 low (esbuild unter skybridge, GHSA-g7r4-m6w7-qqqr, betrifft nur den Windows-Dev-Server). Bewusst zurückgestellt, siehe `ai-company/audit/2026-10-06-dependency-audit.md`. |
| `npm audit` (alle) | zusätzlich 2 moderate in vitest (nur Dev) |
| Install-Skripte | nur esbuild (2 Kopien); fsevents ist optional und unter Linux nicht installiert |
| Versionsbindung | Caret-Ranges, durch den Lockfile fixiert (`npm ci`). `pdf-parse` ist exakt gepinnt. |
| Risikoreiche Pakete | `pdf-parse`/`pdfjs-dist` parsen fremde PDFs, isoliert im Worker-Thread mit Heap-Limit, leerer Umgebung und `isEvalSupported: false` (`src/lexware/file-inspection.ts`). Der Laufzeitbaum von skybridge ist groß (CLI, PostHog, Babel, ink). |
| Registry-Signaturen | `npm audit signatures`: DATA NOT AVAILABLE (Download aus der Sandbox fehlgeschlagen) |

## 2. GitHub Actions

| Prüfung | Ergebnis |
|---|---|
| Berechtigungen | `contents: read` auf oberster Ebene; nur der CodeQL-Job `analyze` hat zusätzlich `security-events: write`. Kein `id-token`, kein `packages`/`actions`/`contents: write`. ✅ |
| Trigger | kein `pull_request_target`, kein `workflow_run`. Keine `github.event.*`-Ausdrücke in `run:`-Schritten, also keine Script-Injection. ✅ |
| Checkout | überall `persist-credentials: false` ✅ |
| Timeouts | jeder Job hat `timeout-minutes` ✅ |
| SHA-Pinning | ❌ kein Action ist auf eine SHA gepinnt. `actions/dependency-review-action@v4` zeigt sogar auf einen **Branch**. |
| CodeQL | `javascript-typescript`, `security-extended`, bei Push, PR und wöchentlich. Workflow-Dateien (`actions`) werden nicht gescannt. |
| dependency-review | `fail-on-severity: high`, nur bei PRs |
| Dependabot | npm, github-actions, docker; monatlich, gruppiert, ohne Cooldown. **Dependabot-Sicherheitsupdates sind aus.** Der Major-Sprung des Docker-Images von Node 24 auf 26 kam über einen solchen Gruppen-PR. |

**Pinning-Tabelle** (aufgelöst per `git ls-remote` am 2026-10-07; vor dem Einsetzen erneut prüfen):

| Action | Ist | SHA | Version |
|---|---|---|---|
| `actions/checkout` | `@v7` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | v7.0.1 |
| `actions/setup-node` | `@v6` | `249970729cb0ef3589644e2896645e5dc5ba9c38` | v6.5.0 |
| `actions/dependency-review-action` | `@v4` (Branch) | `2031cfc080254a8a887f58cffee85186f0e49e48` | v4.9.0 |
| `github/codeql-action/{init,analyze}` | `@v4` | `2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2` | v4.38.2 (Commit des annotierten Tags) |

## 3. Branch- und Release-Schutz (`main`)

Live: Ruleset `main-protection` (ID 24603540), aktiv auf `~DEFAULT_BRANCH`, `bypass_actors: []`. Klassischer Branch-Schutz: keiner.

| Control | Soll | Ist | Status |
|---|---|---|---|
| Kein direkter Push | PR-Pflicht | `pull_request` aktiv | ✅ |
| Kein Force-Push | `non_fast_forward` | aktiv | ✅ |
| Keine Branch-Löschung | `deletion` | aktiv | ✅ |
| Pflichtcheck build-test | ja | ja | ✅ |
| Pflichtcheck secret-scan | ja | ja | ✅ |
| Pflichtcheck CodeQL (`analyze`) | ja | **nein** | ❌ |
| Pflichtcheck dependency-review | ja | **nein** | ❌ |
| Pflichtcheck Produktions-Audit (`audit (production dependencies)`) | ja | **nein** | ❌ |
| Kein Merge bei CRITICAL/HIGH (Code Scanning) | `code_scanning`-Regel | **keine** | ❌ |
| Check-Quelle an GitHub Actions gebunden | `integration_id` | keine | ❌ (jede Identität mit Schreibrecht könnte einen Status gleichen Namens setzen) |
| Branch aktuell vor dem Merge | `strict: true` | `false` | ⚠️ |
| Merge-Methoden | nur Squash | Squash und Merge | ⚠️ |
| Freigaben | 0 (ein Maintainer; eine Selbstfreigabe ist technisch nicht möglich) | 0 | bewusst |
| Bypass-Liste | leer | leer | ✅ (Admins können das Ruleset dennoch ändern) |
| Tag-Schutz | Tag-Ruleset | keiner (keine Tags oder Releases) | ⚠️ |
| Dokumentiertes Ruleset | Soll-Datei | `ai-company/github/ruleset-main.json` ist jetzt das **Soll** (mit allen Pflicht-Checks, `integration_id` 15368 = GitHub Actions, verifiziert über die Check-Runs auf `8f938aa`, Code-Scanning-Regel, nur Squash). Der Live-Stand weicht ab, bis O-1 umgesetzt ist. | ⚠️ |

## 4. Repository-Sicherheitseinstellungen

| Einstellung | Ist |
|---|---|
| Secret Scanning | an ✅ |
| Push Protection | an ✅ |
| Non-Provider-Patterns, Validity Checks | aus |
| Dependabot Security Updates | aus |
| Private Vulnerability Reporting | **aus**, obwohl `SECURITY.md` darauf verweist |
| `delete_branch_on_merge` | aus (alte `claude/*`- und `patch-*`-Branches bleiben) |
| Fork | ja, Netzwerk mit 16 Repos (siehe `history-exposure.md`) |
| Actions-Einstellungen, Collaborators, Deploy-Keys, Webhooks, offene Alerts | DATA NOT AVAILABLE (403) |

## 5. Render und Laufzeit

| Prüfung | Ergebnis |
|---|---|
| Live-Build | `get-server-info`: SHA `8f938aa` (= `main`), Quelle `RENDER_GIT_COMMIT`, Tiers `["read"]`, `effectiveReadOnly: true`, 46 Tools, 0 schreibfähig, Auth `static`, Webhook-Public-Key gesetzt |
| Node-Version | Laufzeit **v26.10.0**, also die Current-Linie und nicht LTS. CI testet auf Node 24 (LTS). Ursache: Dependabot-Gruppen-PR „node 24-slim → 26-slim“. **Behoben in diesem PR:** zurück auf das getestete LTS `node:24-slim`, per Digest gepinnt. |
| Basis-Image | vorher nicht per Digest gepinnt. **Behoben:** Digest-Pin. |
| Laufzeit-User | `USER node` (nicht root), `--chown=node:node` ✅ |
| `.dockerignore` | schließt `.env*`, `.git`, Tests, `.github`, `node_modules` aus ✅ |
| Telemetrie | skybridge sendet standardmäßig ein UDP-Paket an eine fest kodierte IP (Version, bei jedem `tools/call`), die CLI zusätzlich an PostHog. Im Repo war kein Opt-out gesetzt. **Behoben:** `SKYBRIDGE_TELEMETRY_DISABLED=1` und `DO_NOT_TRACK=1` im Laufzeit-Image. |
| `/status` | liefert nur `{status:"ok"}`, die Build-SHA nur über das authentifizierte `get-server-info` ✅ |
| Render-Dashboard (Service-Typ, Auto-Deploy, Deploy-Hooks, Env-Werte, Team, Health-Check-Pfad) | **DATA NOT AVAILABLE**: kein Connector. Die Owner-Aktion steht in `README.md`. |

## 6. Build-Provenance

- npm-Provenance ist nicht anwendbar, weil die App nicht veröffentlicht wird.
- Render baut selbst aus Git. Ein Registry-Image, das attestiert werden könnte, gibt es nicht. Falls später eines in eine Registry geht: `actions/attest-build-provenance` in einem eigenen Job (`id-token: write`, `attestations: write`).
- Sinnvoll jetzt:
  - SHA-gepinnte Actions und ein Digest-gepinntes Basis-Image
  - Render-Auto-Deploy nur nach grüner CI, falls angeboten
  - regelmäßiger Abgleich von `get-server-info.build.sha` mit `main`
  - Das SBOM liefert bereits der GitHub Dependency Graph.

## 7. Restrisiken

- **Ein-Personen-Kontrolle:** Das Owner-Konto ist die letzte Kontrolle. Ein kompromittiertes Admin-Token kann das Ruleset ändern. Mitigation: 2FA bzw. Passkeys, fein granulare und ablaufende Tokens, Audit-Log beobachten.
- **Gate-Dateien:** Ein PR kann Workflows oder den Scanner ändern, an dem er gemessen wird. Lokal schützt der Guard-Hook, serverseitig nur Review-Disziplin, solange keine Code-Owner-Pflicht möglich ist.
- **Unverifiziert:** die Render-Seite, Registry-Signaturen, offene Alerts.
