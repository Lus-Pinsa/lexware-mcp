# Incident Response Plan

Stand: Security Architecture Gate, `main` = `8f938aa`.
**Ziel: Eine kompromittierte Komponente bedeutet nicht, dass das ganze Unternehmen kompromittiert ist.** Jedes Credential hat einen eng begrenzten Wirkungsbereich und lässt sich einzeln widerrufen.

**Rollen:**
- **Owner (Luigi):** entscheidet und führt alle Rotationen mit Produktionswirkung aus.
- **Agents:** erkennen, dokumentieren und schlagen vor. Sie rotieren nie selbst und lesen keine Secrets.

## Credential-Inventar und Wirkungsbereich

| Credential | Wo gespeichert | Was ein Angreifer damit kann | Was er **nicht** kann | Widerruf / Rotation |
|---|---|---|---|---|
| `LEXWARE_API_KEY` | Render-Env (Secret) | Mit der Lexware Public API der Organisation direkt (am MCP-Server vorbei) **lesen und schreiben**, soweit die API und die Key-Rechte das erlauben. Der Read-only-Modus des Servers schützt dann **nicht**. | Lexware-Login der Weboberfläche, Bankkonto, Render, GitHub | Lexware → Einstellungen → Public API: Schlüssel widerrufen und neu erzeugen; danach Render-Env aktualisieren und neu deployen |
| `MCP_AUTH_TOKEN` (Static Bearer) | Render-Env; MCP-Client-Konfiguration (Claude-Connector) | Alle **registrierten** Tools des Servers aufrufen. Heute sind das nur Read-Tools (46, 0 schreibfähig), also Lesezugriff auf die Lexware-Daten über den Server, im Rahmen der Tool-Grenzen. | Schreiben zu Lexware (keine Write-Tools registriert), den API-Key auslesen | Neues Token erzeugen (`openssl rand -hex 32`), Render-Env setzen, deployen, Client-Konfiguration aktualisieren. Das alte Token ist sofort ungültig. |
| OAuth (falls aktiviert): IdP-Konto bzw. Access-Token | IdP (z. B. WorkOS); Token beim Client | Wie oben, für die Laufzeit des Tokens | — | Beim IdP die Session und die Tokens widerrufen, das Nutzerkonto sperren, `OAUTH_ALLOWED_EMAIL_DOMAINS` prüfen |
| Render-Konto / Render-API-Key | Render; Owner-Gerät | Env-Variablen lesen und ändern (damit **alle** Server-Secrets), Deploys auslösen, beliebigen Code ausführen. Das ist der **höchste Wirkungsbereich**. | GitHub-Repo ändern (außer über die verbundene Integration) | Render: API-Keys widerrufen, Passwort ändern, 2FA prüfen, Team-Mitglieder prüfen; danach **alle** Env-Secrets rotieren |
| GitHub-Konto / Token des Owners | GitHub; Owner-Gerät | Repo ändern. Der Ruleset verhindert direkte Pushes auf `main`, aber der Owner kann ihn ändern. Über Auto-Deploy von `main` läuft der Code auf Render. | Render-Env direkt lesen | GitHub: Tokens und Sessions widerrufen, 2FA prüfen, Deploy-Keys und Apps prüfen, Audit-Log sichten |
| `GITHUB_TOKEN` in Actions | Kurzlebig pro Run | Nur `contents: read` (CI) bzw. `security-events: write` (CodeQL) | Pushen, Releases, Secrets | Läuft automatisch ab; bei Missbrauchsverdacht Actions deaktivieren und Workflows prüfen |
| Claude/Agent-Sessions | Claude-Konto | Was die Session darf: Read-Tools, PRs auf Feature-Branches. Kein Merge, kein Force-Push (`.claude/settings.json`, Guard-Hook, Ruleset). | Lexware-Writes (Tools deny-gelistet und serverseitig nicht registriert) | Claude-Konto: Sessions beenden, Connector-Token (`MCP_AUTH_TOKEN`) rotieren |
| `LEXWARE_WEBHOOK_PUBLIC_KEY` | Render-Env | Öffentlicher Schlüssel, nicht geheim. Wird er manipuliert (über Render), werden gefälschte Webhooks angenommen. | — | Aus der Lexware-Dokumentation neu setzen |

## Ablauf pro Vorfall

### 1. Detect (Erkennen)

| Signal | Quelle |
|---|---|
| Unerwartete Tool-Aufrufe oder Last | Render-Logs (Request-Zähler, 401/429), Lexware-Rate-Limit-Fehler |
| Build-SHA weicht von `main` ab | `get-server-info` → `build.sha` mit `git rev-parse origin/main` vergleichen |
| Tiers nicht `["read"]` oder `writeCapable` nicht leer | `get-server-info` |
| Unerwartete Belege, Kontakte oder Änderungen in Lexware | Lexware-Weboberfläche, Änderungsprotokoll |
| Secret im Repo | GitHub Secret Scanning (Push Protection aktiv), CI `secret-scan` |
| Fremde Commits, Ruleset-Änderungen | GitHub-Audit-Log, Benachrichtigungen |
| Env-Änderungen, Deploys ohne Commit | Render-Events |

### 2. Contain (Eindämmen)

- **MCP-Zugriff sperren:** `MCP_AUTH_TOKEN` in Render auf einen neuen Wert setzen. Danach haben alle bisherigen Clients keinen Zugriff mehr.
- **Server stoppen:** Render → Service → Suspend. Lexware bleibt davon unberührt.
- **Schreibfähigkeit ausschließen:** `LEXWARE_READ_ONLY=true` setzen. Das ist schon heute der effektive Zustand; prüfen mit `get-server-info`.
- **Agents stoppen:** Claude-Sessions beenden, keine neuen PRs mergen.
- **GitHub:** Bei Verdacht auf eine Repo-Kompromittierung den Auto-Deploy in Render pausieren.

### 3. Revoke (Widerrufen)

Das betroffene Credential gemäß Inventar widerrufen. Bei einer Render-Kompromittierung **alle** Server-Secrets widerrufen, denn sie waren lesbar.

### 4. Rotate (Erneuern)

- Neue Werte erzeugt nur der Owner. Sie werden nur im Secret-Store gesetzt, nie im Chat, in Issues oder PRs.
- Reihenfolge: zuerst Lexware-Key, dann MCP-Token, dann deployen, dann prüfen.
- Rotationen mit Produktionswirkung sind HARD STOP für Agents und werden ausschließlich vom Owner ausgeführt.

### 5. Recover (Wiederherstellen)

- Den Deploy von einem bekannten, geprüften Commit auf `main` neu auslösen und die Build-SHA mit `get-server-info` verifizieren.
- Lexware-Daten auf unerwartete Änderungen prüfen: Belege, Kontakte, Webhook-Abonnements (`list-event-subscriptions`).
- Ab PR 3: Persistence-Daten aus einem verifizierten Backup wiederherstellen (Persistence-Vertrag P-60 bis P-62). Nicht vertrauenswürdige Snapshots werden verworfen.

### 6. Audit (Aufarbeiten)

- Ein Bericht unter `ai-company/audit/` enthält nur qualitative Angaben: keine Beträge, keine Secrets, keine Personendaten.
- Inhalt: Zeitlinie, betroffene Credentials, Wirkungsbereich, Ursache, Maßnahmen, neue Controls.
- Regressionstest oder Gate ergänzen, wenn die Ursache technisch war.

## Vorbereitende Maßnahmen (Owner)

Die Owner-Aktionen stehen in `README.md` im Abschnitt „Owner Actions“, darunter 2FA auf GitHub, Render, Lexware und beim IdP sowie ein separater Lexware-API-Key nur für diesen Server.
