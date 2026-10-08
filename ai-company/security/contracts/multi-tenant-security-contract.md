# Multi-Tenant Security Contract

Status: **verbindlich als Architekturgrenze ab PR 3**. Es wird kein SaaS-System gebaut. Ziel ist nur, dass PR 3 keine Sackgasse baut.
Basis: Security Architecture Gate, `main` = `8f938aa`.

## Ist-Zustand

- **Ein Deployment, ein Tenant.** `LEXWARE_API_KEY` bindet den Server an genau eine Lexware-Organisation (`src/config.ts`). Jeder authentifizierte MCP-Client handelt mit diesem Schlüssel.
- **Auth-Identität ist nicht an einen Tenant gebunden.**
  - Im Modus `static` gibt es nur ein gemeinsames Bearer-Token und keine Identität.
  - Im Modus `oauth` gibt es eine Identität (`sub`, optional E-Mail-Domain-Allowlist). Daraus wird aber keine Tenant-Berechtigung abgeleitet.
- **Webhooks:** Ereignisse werden über die Signatur des Lexware-Public-Keys angenommen. Die Bindung an die erwartete `organizationId` ist im Attack-Surface-Audit bewertet (`../attack-surface-audit.md`).
- **Folge heute:** Wer authentifiziert ist, hat Zugriff auf alle Lesedaten der einen Organisation. Das ist für den Einzelbetrieb von LU'S akzeptiert und muss für jeden zweiten Tenant aufgehoben werden.

## Begriffe

| Begriff | Bedeutung |
|---|---|
| `tenantId` | Interne, unveränderliche ID eines Kunden-Mandanten, z. B. UUIDv4. Wird nie aus Nutzereingaben übernommen. |
| `organizationId` | Die Lexware-Organisation (aus dem Lexware-Profil bzw. dem Webhook). Jeder Tenant hat genau eine `organizationId`; die Zuordnung ist serverseitig gespeichert. |
| Principal | Die authentifizierte Identität (OAuth `iss` + `sub`). Sie ist **kein** Tenant. |
| Membership | Explizite, serverseitig gespeicherte Berechtigung `(principal, tenantId, rolle)`. |

## Anforderungen

| ID | Anforderung |
|---|---|
| T-01 | MUSS: Jeder persistierte Datensatz hat eine `tenant_id NOT NULL`. Ausnahmen sind nur globale Systemtabellen wie die Schema-Version, und sie sind benannt. |
| T-02 | MUSS: Jede Query ist tenant-gebunden. Der Datenzugriff läuft über eine Repository-Schicht, die `tenantId` als Pflichtparameter verlangt. Es gibt keine Funktion ohne `tenantId`. Ein statischer Test prüft, dass außerhalb der Repository-Schicht kein direkter DB-Zugriff existiert. |
| T-03 | MUSS: Keine Cross-Tenant-Queries im Anwendungscode. Auswertungen über mehrere Tenants (z. B. Betriebsstatistik) gibt es nur als Zähler und nur in einem separaten, nicht über MCP erreichbaren Admin-Pfad. Das ist eine eigene spätere Owner-Entscheidung. |
| T-04 | MUSS: Keine implizite Default-Tenant-Logik. Fehlt die Tenant-Auflösung, wird die Anfrage abgelehnt (Fail closed). Es gibt kein „erster Tenant“, kein `tenantId = 1` und keinen Fallback auf den Env-Key für unbekannte Principals. |
| T-05 | MUSS: Auth-Identität ist nicht automatisch ein Tenant. Ein gültiges OAuth-Token allein gewährt keinen Tenant-Zugriff. Der Zugriff braucht eine Membership. Eine E-Mail-Domain-Allowlist ist ein zusätzlicher Riegel, aber keine Tenant-Zuordnung. |
| T-06 | MUSS: Der Tenant-Zugriff wird explizit autorisiert. Jede Tool-Ausführung löst `principal → tenantId` serverseitig auf, und zwar einmal pro Request. Die Tenant-ID reicht als unveränderlicher Kontext durch alle Schichten (Loader, Fassade, Persistence). Tool-Parameter dürfen den Tenant nicht wählen, außer der Principal hat mehrere Memberships und wählt einen eigenen; das wird dann geprüft. |
| T-07 | MUSS: Lexware-Credentials gelten pro Tenant. Ein Tenant nutzt nur seinen eigenen Lexware-Schlüssel. Die Zuordnung `tenantId → Credential-Referenz` liegt im Secret-Store und nicht in der App-DB (Persistence-Vertrag P-12). Ein Client-Objekt wird pro Request mit dem Credential des aufgelösten Tenants erzeugt; es gibt keinen globalen Client für mehrere Tenants. |
| T-08 | MUSS: Webhook-Bindung. Ein Webhook-Ereignis wird nur angenommen, wenn die Signatur gültig ist **und** die `organizationId` einem bekannten Tenant zugeordnet ist. Das Ereignis wird nur diesem Tenant zugestellt. Unbekannte Organisationen werden verworfen und gezählt; ihr Inhalt wird nicht gespeichert. |
| T-09 | MUSS: Caches und RAM-Queues (z. B. `pending-voucher-events`) sind pro Tenant getrennt, mit eigener Obergrenze. |
| T-10 | MUSS: Logs und Audit-Einträge tragen die `tenantId` und keine Tenant-fremden Inhalte. |
| T-11 | MUSS: Tests für horizontale Rechteausweitung. Principal A mit Membership für Tenant 1 erhält bei jedem Tool und jeder Query keine Daten von Tenant 2, auch nicht über manipulierte IDs, Webhooks oder Cache-Schlüssel. Diese Tests sind Teil jedes PRs, der Persistence oder Auth berührt. |
| T-12 | SOLL: Datenbank-seitige Absicherung als zweite Linie, z. B. PostgreSQL Row Level Security mit `current_setting('app.tenant_id')`, wenn Postgres gewählt wird. |
| T-13 | MUSS: Das Read-Tier ist pro Tenant konfigurierbar. Die Read-only-Grenze für einen Tenant darf nie durch die Konfiguration eines anderen Tenants aufgehoben werden. |

## Was PR 3 konkret tun muss

1. Das Schema enthält von Anfang an `tenant_id` (T-01). Der LU'S-Betrieb bekommt einen explizit angelegten Tenant (keine implizite Anlage).
2. Die Repository-Schicht verlangt `tenantId` als Pflichtparameter (T-02). Im Einzelbetrieb wird der Tenant explizit aus der Konfiguration aufgelöst, z. B. über `LUS_TENANT_ID`, und beim Start mit der `organizationId` aus dem Lexware-Profil abgeglichen. Bei Abweichung startet die Persistence nicht.
3. Die Webhook-Ereignisse werden mit dem `organizationId`-Abgleich gespeichert (T-08).
4. Es gibt **keine** Membership-Verwaltung, kein Signup und kein Billing. Das folgt erst, wenn sich das Produkt dafür entscheidet.

## Nicht-Ziele

- Kein Self-Service-Onboarding, keine Tenant-Admin-UI.
- Keine Kosten für Multi-Tenant-Infrastruktur ohne Owner-Freigabe.
