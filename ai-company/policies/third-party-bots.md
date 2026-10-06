# Policy: Drittanbieter-Bots und -Integrationen

Es wird **nichts automatisch installiert**. Zuerst werden native Funktionen von Claude, GitHub und der
bestehenden Infrastruktur genutzt.

## Prüfschema vor jeder Installation

| Kriterium | Frage |
|---|---|
| Anbieter | Wer steht dahinter? Gibt es ein Impressum, eine Firma und eine Historie? |
| Maintenance | Letzte Releases, offene Security-Issues, Bus-Faktor |
| Security | Welche Rechte (Repo-Write, Secrets, Actions)? Gibt es Pinning per SHA? |
| Berechtigungen | Minimal möglich? Nur lesend? |
| Datenschutz | Welche Daten verlassen das Repo? Ist AV-Vertrag oder DSGVO geklärt? |
| Lizenz | OSS-Lizenz, ist kommerzielle Nutzung erlaubt? |
| Kosten | Free-Tier-Grenzen, Preis pro Seat oder Repo |
| Vendor Lock-in | Austauschbar? Exportierbar? |
| Nutzen vs. nativ | Was kann der Bot, was Claude-Agenten plus GitHub nativ nicht können? |

## Bewertung bekannter Optionen (Stand 06.10.2026, ohne Installation)

| Option | Bewertung | Empfehlung |
|---|---|---|
| GitHub CodeQL, Dependency Review, Dependabot, Secret Scanning | nativ, für öffentliche Repos kostenlos, keine Daten an Dritte | **nutzen**. CodeQL und Dependency Review sind in CI eingerichtet. Secret Scanning und Push Protection muss Luigi aktivieren. |
| gitleaks-action | Für Organisationskonten ist eine Lizenz nötig. Dieses Repo gehört einem Nutzerkonto. Es ist eine Drittanbieter-Action. | **nicht nötig**: Der eigene Scanner ohne Abhängigkeiten deckt den Bedarf, GitHub-natives Scanning ergänzt ihn |
| SaaS-AI-Review-Bots (diverse) | Code geht an Dritte, oft kostenpflichtig, mit Lock-in | **nicht installieren**. Unabhängige Claude-Reviewer-Agenten decken den Bedarf ab. |
| Render-MCP (offiziell) | würde den Deploy Verifier mit echten Status- und Log-Reads versorgen. Laut Radar hat er ein `trigger_deploy`-Tool (unverifiziert). | **prüfen**: nur mit API-Key, der wenn möglich nur lesen darf. Write-Tools per Settings und Hook sperren. Freigabe durch Luigi. |
