# Policy: Berechtigungen (Least Privilege)

**Maschinenlesbare Quelle:** `ai-company/core/permission-profiles.json`.
**Technisch durchgesetzt durch:** `.claude/agents/*.md` (Tool-Listen), `.claude/settings.json`
(Deny/Ask), `.claude/hooks/guard.mjs` (PreToolUse), `tests/governance.test.ts` (CI) und die
serverseitigen Tiers im lexware-mcp (`src/config.ts`, `src/tools/index.ts`,
`tests/finance-policy.test.ts`).

## Grundsätze

1. Jede Rolle hat genau ein Profil. Ein Agent darf keine Tools deklarieren, die über das Profil
   hinausgehen. Das prüft CI.
2. Orchestrierungswissen und Produktionsrechte sind getrennt. Der Cloud CEO plant und delegiert,
   hat aber keine Schreib-, Prod-, Finance-, Deploy- oder Secret-Rechte.
3. Reviewer und Auditoren haben **nie** Edit/Write. Prüfer und Ersteller sind verschiedene Agenten.
4. In Phase 1 gilt für alle Profile: kein Finance-Write, kein Prod-Write, kein Deploy, keine Secrets.
5. Unbekannte Aktion oder unbekanntes Profil führt zur Ablehnung (fail closed, `decideAction()` in
   `ai-company/core/governance.ts`).
6. Der Office Agent (künftig) bekommt nur fachlich definierte Tools und darf **seinen eigenen
   Programmcode nicht verändern**. Dafür hat er kein Edit/Write/Bash, und die Gate-Dateien sind per Hook geschützt.

## Matrix der kritischen Agenten

| Agent | READ | WRITE (Repo) | PROD | FINANCE | DEPLOY | SECRETS |
|---|---|---|---|---|---|---|
| cloud-ceo | ja | nein | nein | nein | nein | nein |
| engineering-lead, qa-lead | ja (+ Tests) | nein | nein | nein | nein | nein |
| typescript-engineer, test-engineer | ja | nur Feature-Branch, PR | nein | nein | nein | nein |
| knowledge-steward | ja | nur Doku/Config unter `ai-company/`, Branch | nein | nein | nein | nein |
| code-reviewer, security-lead, security-auditor, final-auditor | ja (+ Tests/Audit) | nein | nein | nein | nein | nein |
| deploy-verifier | ja | nein | nur lesen (Health/Logs) | nein | nein | nein |
| finance-lead, finance-auditor | ja | nein | nur lesen | nur lesen (Lexware-Read-Tools) | nein | nein |
| daily-coo | ja | nein | nur lesen | nur lesen (Queue/Reconciliation) | nein | nein |
| technology-radar | ja (+ offizielle Webquellen) | nein | nein | nein | nein | nein |
| board-analyst (geplante Business-Rollen) | ja | nein | nein | nein | nein | nein |

## Was jeder Builder ausdrücklich NICHT darf

- auf `main` pushen, force-pushen, PRs mergen (Hook + Settings + Ruleset-Empfehlung)
- Render-Secrets lesen, `.env` lesen oder Secrets ausgeben (Hook + Settings)
- Lexware-Produktion schreiben (Settings-Deny + Hook + Agent-Tool-Listen)
- eigene Safety Gates entfernen: `.claude/settings.json`, `.claude/hooks/`, `.github/workflows/`
  und `CODEOWNERS` sind per Hook gesperrt. Änderungen daran gibt es nur, wenn ein Mensch
  `AI_COMPANY_GATE_MAINTENANCE=1` in der Umgebung setzt. Gemergt wird ausschließlich durch Luigi; Agenten
  können nicht mergen (Hook + Settings). Hinweis: Mit einem einzigen Maintainer verlangt das Ruleset
  0 Approvals, CODEOWNERS dokumentiert deshalb Zuständigkeit, erzwingt aber keine zweite Person.

## Grenzen dieser Durchsetzung (ehrlich)

- Hooks und Settings gelten nur für **Claude-Code-Sessions in diesem Repository**. Ein direkter
  Chat in claude.ai mit dem Connector „LU'S Lexware“ unterliegt ihnen **nicht**. Dort schützt nur
  die serverseitige Tier-Konfiguration. Siehe `finance-write-gates.md`.
- Läuft der Cloud CEO als Hauptsession (Skill statt `--agent`), hat er technisch die Tools
  der Hauptsession. Die Begrenzung erfolgt dann über Hook, Settings und Skill-Regeln, nicht über die Tool-Liste.
- Das `Agent`-Tool des CEO ist nicht auf benannte Agenten beschränkt; er könnte einen `general-purpose`-
  Subagenten mit allen Tools starten. Die Einschränkung auf registrierte Agenten ist für Phase 2 vorgesehen.
- Reviewer-Profile erlauben `Bash` (für Tests). Damit könnten sie technisch Dateien schreiben; „editiert
  nie“ beruht dort auf Anweisung.
- Der Guard-Hook arbeitet string-basiert, ist umgehbar und erzeugt False Positives. Er ist eine Leitplanke,
  keine Sandbox. Härtungsvorschlag: `ai-company/audit/2026-10-06-final-audit.md`.
