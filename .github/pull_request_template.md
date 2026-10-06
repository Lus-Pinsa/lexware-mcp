## Was ändert sich?

<!-- Kurz: Ziel, betroffene Boards, betroffene Dateien. -->

## Review-Loop (ai-company/policies/review-loop-and-escalation.md)

- [ ] Ersteller ≠ Reviewer (bei kritischen Änderungen zusätzlich ≠ technisches Gate/CI)
- [ ] Tests ergänzt oder angepasst; `npm run build`, `npm test` und `npm run typecheck:governance` sind lokal grün
- [ ] Höchstens 3 Fix-Runden, sonst BLOCKED und eskaliert
- [ ] Security Review nötig? (Auth, Tiers, Write-Tools, Dependencies, Hooks/Settings/CI). Wenn ja: durchgeführt.

## Sicherheits-Checkliste

- [ ] Keine Secrets, keine Geschäftsdaten (Beträge, Kontakte, IDs, Steuernummern). Das Repo ist öffentlich.
- [ ] Keine neue Finance-Write-Fähigkeit. Falls doch: separates, bestätigungspflichtiges Tool, `tests/finance-policy.test.ts` bewusst angepasst, Freigabe durch Luigi.
- [ ] Keine Abschwächung von `.claude/settings.json`, `.claude/hooks/`, Workflows oder CODEOWNERS.
- [ ] Keine neuen kostenpflichtigen Dienste oder Abhängigkeiten ohne Freigabe.

## Nachweis

<!-- Befehle + Ergebnisse, CI-Link. GRÜN nur mit Nachweis. -->
