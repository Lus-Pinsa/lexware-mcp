# Policy: Ressourcen- und Kosten-Governance

## Regeln

1. **Kein kostenpflichtiges Upgrade und kein neuer kostenpflichtiger Dienst ohne Luigi.** Das gilt
   für Render-Plan, GitHub-Tarif, SaaS-Bots, API-Keys und Datenquellen.
2. **Event-driven vor Polling.** Beispiele: Der Lexware-Webhook füllt die Queue, PR-Events wecken
   Sessions. Es gibt keine permanenten Agent-Loops.
3. **Keine wiederkehrenden Routinen** (Cron/Trigger) ohne Freigabe durch Luigi. In der Foundation wurden **keine**
   angelegt.
4. **Kleinstes geeignetes Modell** je Rolle, festgelegt im Frontmatter der Agent-Datei:
   - `inherit` (stärkstes Modell): Cloud CEO und unabhängige Auditoren (code-reviewer,
     security-auditor, final-auditor, finance-auditor), weil hier Urteilsqualität vor Kosten geht
   - `sonnet`: Leads und Specialists
   - `haiku`: deploy-verifier (einfache Health- und Log-Checks)
5. **Parallelität nur bei echter Unabhängigkeit.** Der CEO startet parallele Agenten nur, wenn
   keine Daten- oder Dateiabhängigkeit besteht. Jeder Agent kostet Tokens.
6. **Retry-Limit 3** verhindert teure Endlosschleifen. Das ist technisch gedeckelt.

## Was laufende AI-Nutzung erzeugt

| Prozess | Auslöser | Laufende Kosten |
|---|---|---|
| Claude-Code-Session (CEO + Subagenten) | manuell durch Luigi | nur pro Anfrage |
| lexware-mcp auf Render | Dauerbetrieb | Render-Plan (unverändert, nicht Teil dieser Foundation) |
| Lexware-Webhook → Queue | Event (`voucher.created`) | keine AI-Kosten, bis jemand die Queue abfragt |
| GitHub Actions CI / CodeQL | PR/Push, CodeQL zusätzlich wöchentlich | für öffentliche Repos kostenlos |
| Technology Radar | **nur manuell**, kein Cron | pro Lauf |
| Daily COO Brief | **nur manuell**, kein Cron | pro Lauf |

## Was später teuer werden könnte (beobachten)

- Ein täglicher Brief oder Radar als Cron mit starkem Modell und vielen Subagenten
- Breite parallele Fan-outs („alle 19 Boards prüfen“)
- Große PDF-Texte (bis 200.000 Zeichen) im Kontext. Standard ist 50.000, besser niedriger halten.
- Render: Ein Upgrade auf einen Plan ohne Spin-down wäre kostenpflichtig und braucht Luigi.

## Nicht aktiviert (bewusst)

Keine kostenpflichtigen GitHub-Features (GHAS für private Repos), keine SaaS-Review-Bots, keine
neuen API-Abos, kein Render-Upgrade, keine Cron-Routinen.
