# Policy: Finance-Write-Gates

**Status Phase 1 (aktualisiert 2026-10-25): Agenten führen keine produktiven Finance-Writes aus.** Der Server
exponiert seit #41 (produktiv seit 2026-10-22) genau **ein** Schreib-Tool, `update-voucher`, beschränkt auf
Belege mit Status `unchecked` – als dokumentierte Owner-Ausnahme für die Buchhaltungsautomatik, siehe
`ai-company/audit/2026-10-25-adr-update-voucher-phase1-exception.md`. Agenten in Claude-Code-Sessions bleiben
per `settings.json`, Guard-Hook und `governance.test.ts` gesperrt.

## Ebenen (Defense in Depth)

| Ebene | Mechanismus | Schützt vor | Gilt für |
|---|---|---|---|
| 1. Server (lexware-mcp) | Tiers in `src/config.ts` / `src/tools/index.ts`. `LEXWARE_ENABLE_FINALIZE=false` heißt: keine `create-finalized-*`-, `delete-*`- oder freien Webhook-Tools | irreversiblen, rechtsverbindlichen Aktionen | **alle** Clients, auch claude.ai-Chat |
| 2. Policy-Test | `tests/finance-policy.test.ts` friert die erlaubte Menge schreibender Tools ein | unbemerkter Erweiterung der Write-Fläche | jede Code-Änderung (CI) |
| 3. Claude-Code-Settings | `.claude/settings.json` sperrt per `deny` alle Lexware-Write-/Finalize-Tools; `acknowledge` steht auf `ask` | Agenten in Claude-Code-Sessions | Sessions in diesem Repo |
| 4. Guard-Hook | `.claude/hooks/guard.mjs` blockiert jedes Lexware-Tool mit `create/update/upload/delete/ensure/finalize/...`, unabhängig vom Servernamen, sowie direkte API-Aufrufe | umbenannten Connectoren und Umgehung per curl | Sessions in diesem Repo |
| 5. Agent-Tool-Listen | Finance-Agenten deklarieren nur Read-Tools; CI prüft das gegen `customer.json` → `capabilityTools` | falsch konfigurierten Agenten | Subagenten |

## Tatsächliche serverseitige Write-Fläche in Produktion

**Stand 2026-10-22 (verifiziert per `get-server-info`, Build `883b572`):** read + drafts aktiv, finalize aus,
`LEXWARE_WRITE_TOOLS=update-voucher`, `LEXWARE_UPDATE_VOUCHER_UNCHECKED_ONLY=true`. Erreichbar ist genau **ein**
zustandsänderndes Tool: `update-voucher`, nur für Belege mit Status `unchecked`. Auf Build `883b572` hinterlässt
jeder Aufruf eine SHA-256-verkettete Protokollzeile; nach dem Deploy des Härtungs-PR (#42) sind es zwei
HMAC-verkettete Zeilen (Versuch, Ergebnis). `tests/finance-policy.test.ts` friert dieses Profil ein („hardened
production profile“).

Historischer Stand 06.10.2026 (vor #41): read + drafts aktiv, finalize aus, keine Allowlist. Damit waren
**16 zustandsändernde Tools** auf dem Server erreichbar:

- `acknowledge-voucher-event`: nur die lokale RAM-Queue, ändert nichts in Lexware
- `ensure-lus-voucher-webhook`: legt nur das fest verdrahtete `voucher.created`-Abo an, ohne Eingabeparameter
- `create-contact`, `update-contact`, `create-article`, `update-article`
- `create-draft-invoice|quotation|credit-note|order-confirmation|delivery-note|dunning` (Entwürfe, nicht rechtsverbindlich)
- **`create-voucher`, `update-voucher`, `upload-file`, `upload-voucher-file`**: Buchhaltungsbelege und
  Dateien. Diese Änderungen lassen sich teilweise per API **nicht** rückgängig machen. Laut
  Security-Review ist `voucherStatus` ein freier String, ein Beleg kann damit also gebucht werden.

`LEXWARE_READ_ONLY` ist in Produktion `false`. Die Sicherheit beruht deshalb **nicht** auf diesem Flag, sondern auf
der Allowlist (fail closed bei unbekannten Namen) und der `unchecked`-Beschränkung.

## Restrisiko (wichtig)

Ebenen 3–5 wirken nur in Claude-Code-Sessions dieses Repositories. In einem **claude.ai-Chat mit
dem Connector „LU'S Lexware“** stehen die 16 Tools technisch zur Verfügung. Schutz bieten dort
nur Ebene 1 (kein Finalize) und die Tool-Bestätigung im Claude-Client.

**Entscheidung (getroffen durch den Merge von #41 am 17.10.2026): Option 3, erster Teil** – `update-voucher` ist
serverseitig auf `voucherStatus="unchecked"` beschränkt. Ein eigenes, bestätigungspflichtiges Buchungs-Tool (zweiter
Teil von Option 3) gibt es noch nicht; das Buchen geschieht über `update-voucher` mit `voucherStatus:"open"`.
Ursprüngliche Optionen:
1. Auf Render `LEXWARE_READ_ONLY=true` setzen, bis Phase 2 kontrollierte Write-Module liefert.
   Dann fallen auch `acknowledge-voucher-event` und `ensure-lus-voucher-webhook` weg. Die Read-Pipeline
   bleibt vollständig erhalten.
2. Oder `LEXWARE_ENABLE_DRAFTS=false`, mit derselben Wirkung auf die Write-Tools.
3. Oder in Phase 2 serverseitig ein eigenes, bestätigungspflichtiges Buchungs-Tool einführen und
   `create-voucher`/`update-voucher` auf `voucherStatus="unchecked"` beschränken.

## Regel für Phase 2

Jede neue schreibende Finance-Fähigkeit braucht:
- ein eigenes Tool mit einem expliziten Bestätigungsargument, niemals ein Flag an einem bestehenden Tool,
- einen Eintrag in `PRODUCTION_WRITE_TOOLS` (`tests/finance-policy.test.ts`) mit Security-Sign-off,
- Idempotenz: kein Retry nicht-idempotenter POSTs, Dublettenprüfung vor dem Write,
- einen Audit-Log-Eintrag ohne Geschäftsdaten im öffentlichen Repo,
- die Freigabe durch Luigi.
