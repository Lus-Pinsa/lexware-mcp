# LU'S AI Company: Foundation (V1)

Ein kontrolliertes Multi-Agent-Betriebssystem auf Basis von Claude Code, mit **LU'S als Pilotkunde**.
Luigi hat genau einen Ansprechpartner, den **Cloud CEO**. Dieser orchestriert Boards, Leads,
Specialists, unabhängige Reviewer und technische Gates.

## So spricht Luigi mit dem CEO

In einer Claude-Code-Session in diesem Repository (App, Web oder CLI) schreibt Luigi in normaler Sprache:

> „Bro, check Finance.“ · „Lass Finance weiterarbeiten und parallel Instagram und SEO starten.“ ·
> „Was muss ich heute entscheiden?“ · „Welche neuen KI-Möglichkeiten gibt es für uns?“

Die Session nutzt dann den Skill **`cloud-ceo`** (`.claude/skills/cloud-ceo/SKILL.md`). Alternativ läuft die
ganze Session als CEO: `claude --agent cloud-ceo`. Das ist ein PoC, Details in `radar/README.md`.

## Aufbau

```
.claude/
  agents/        16 ausführbare Rollen (CEO, Leads, Specialists, unabhängige Reviewer)
  skills/        cloud-ceo: Betriebsablauf des CEO
  rules/         immer geladene harte Regeln
  hooks/         guard.mjs: PreToolUse-Sicherheitsgate (deterministisch)
  settings.json  Deny/Ask-Regeln + Hook-Registrierung
ai-company/
  core/          kundenneutral: org.json (19 Boards), permission-profiles.json,
                 governance.ts (Status, Review-Loop ≤3, Trennung der Aufgaben, Policy),
                 registry.ts (Validierung, die CI erzwingt)
  policies/      Berechtigungen, Finance-Gates, Review/Eskalation, Kosten, Source of Truth,
                 Security, Drittanbieter
  boards/        catalog.md: Arbeitsweise und Status je Board
  customers/     lus/ (Pilot), _template/ (für weitere Gastronomen)
  radar/         Technology-Radar-Quellen und Workflow
  scripts/       secret-scan.mjs (Credentials + Geschäftsdaten, ohne Abhängigkeiten)
  github/        ruleset-main.json (Branch-Schutz zum Import durch Luigi)
  audit/         Inventur, Testnachweise, Final Report
```

## Harte Regeln (Kurzfassung)

1. **Ersteller ≠ Prüfer**. Bei kritischen Themen zusätzlich ≠ technisches Gate (CI).
2. **Fail closed**: Bei Unsicherheit gibt es keine produktive Aktion, sondern GELB oder ROT mit Blocker und Entscheidung.
3. **Maximal 3 Fix-/Review-Runden**, dann BLOCKED und Eskalation. Das ist im Code gedeckelt.
4. **GRÜN nur mit Nachweis.**
5. **Phase 1: keine produktiven Writes** (Finance, Social, Bestellungen, Kunden, Zahlungen, Preise).
6. **Keine Kosten ohne Luigi.** Event-driven statt Polling.
7. **Öffentliches Repo**: keine Secrets, keine Geschäftsdaten.

## Prüfen

```bash
npm run build && npm run typecheck:governance && npm test && npm run secret-scan
```
