# Owner-Checkliste Phase 1 (Luigi)

Diese Aktionen kann nur Luigi ausführen. Den Agenten fehlt dafür ein Connector bzw. die Berechtigung, und Gate-Änderungen
sind absichtlich gesperrt. Keine Aktion verursacht Kosten.

## 1. GitHub Dependency Graph aktivieren

1. https://github.com/Lus-Pinsa/lexware-mcp öffnen, dann **Settings**.
2. Links **Advanced Security** wählen (ältere Bezeichnung: *Code security and analysis*).
3. Bei **Dependency graph** auf **Enable** klicken.
4. Empfohlen, ebenfalls kostenlos für öffentliche Repos: **Dependabot alerts** und **Secret scanning / Push protection** aktivieren.

Prüfen: Beim nächsten Push auf PR #2 oder PR #3 wird der CI-Job `dependency-review` grün.

## 2. Branch-Schutz: Ruleset importieren

1. Die Datei `ai-company/github/ruleset-main.json` aus PR #2 herunterladen: Datei auf GitHub öffnen, dann **Raw**, dann speichern.
2. Repo → **Settings** → **Rules** → **Rulesets** → **New ruleset** → **Import a ruleset** → die Datei auswählen.
3. Prüfen: *Enforcement status* = **Active**, *Target* = Default branch (`main`), *Bypass list* = leer → **Create**.

Wirkung: Auf `main` sind Löschen, Force-Push und Direkt-Push verboten. Merges laufen nur über PRs, und dafür müssen die
Checks `build-test (typecheck, tests, governance)` und `secret-scan (credentials + business data)` grün sein. Es sind 0
Approvals verlangt, damit Luigi als einziger Maintainer eigene PRs mergen kann.
Empfehlung nach dem Merge von PR #3: im Ruleset zusätzlich `audit (production dependencies)` und `CodeQL` als Pflicht-Checks eintragen.

## 3. Render: Lexware serverseitig auf read-only stellen

1. https://dashboard.render.com öffnen → Service **lus-lexware-mcp** → **Environment**.
2. Variable **`LEXWARE_READ_ONLY`** = **`true`** setzen. Neu anlegen oder vorhandenes `false` ersetzen.
3. Empfohlen auf derselben Seite:
   - **`SKYBRIDGE_TELEMETRY_DISABLED`** = **`1`**: schaltet den anonymen Nutzungszähler von skybridge ab.
   - Prüfen, dass **`NODE_ENV`** = **`production`** gesetzt ist oder der Service per Docker läuft. Das Dockerfile setzt es,
     ohne die Variable lädt skybridge den Dev-Modus.
4. **Save** wählen. Render deployt neu.
5. Prüfen:
   - Im Render-Log erscheint `[lexware-mcp] starting — tiers=[read] …`, ohne `drafts`.
   - In Claude zeigt der Connector „LU'S Lexware“ nur noch Lese-Tools. Ggf. Connector trennen und neu verbinden,
     damit die Tool-Liste neu geladen wird.

**Was bleibt erhalten (per Test belegt, `tests/finance-policy.test.ts`):** alle 40 Lese-Tools, darunter
`get-pending-voucher-events`, `reconcile-recent-vouchers`, `get-voucher`, `get-voucher-file-text` und `list-event-subscriptions`.
Der signierte Webhook-Empfänger `/webhooks/lexware` hängt nicht an den Tiers und läuft weiter. Das bestehende Lexware-Abo bleibt bestehen.

**Was entfällt:** die 15 Lexware-Write-Tools sowie `acknowledge-voucher-event` und `ensure-lus-voucher-webhook`. Folge:
Queue-Einträge lassen sich nicht mehr quittieren und bleiben bis zum nächsten Restart im Speicher. Das ist wenig Speicher, und die
Reconciliation bleibt die maßgebliche Prüfung.

## 4. (Optional) Wartungsfreigabe für die Härtung des Guard-Hooks

Der Hook sperrt Änderungen an sich selbst, an `.claude/settings.json`, an den Workflows und an `CODEOWNERS`. Für die Härtung
aus `ai-company/audit/2026-10-06-final-audit.md`:

1. Claude-Code-Cloud-Umgebung öffnen: Menü der Umgebung in der Titelleiste der Session → **Edit** → Umgebungsvariable
   **`AI_COMPANY_GATE_MAINTENANCE`** = **`1`** setzen.
2. Eine **neue** Session starten und die Härtung beauftragen. Die Variable gilt erst in neuen Sessions.
3. Danach die Variable wieder **entfernen**.
