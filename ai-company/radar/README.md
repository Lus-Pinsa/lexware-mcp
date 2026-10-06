# AI / Technology Radar

**Agent:** `.claude/agents/technology-radar.md` · **Quellen:** `sources.json` · **Reviewer:** security-auditor

## Workflow

```
neue Fähigkeit → Radar-Eintrag → Nutzen/Risiko/Kosten → Security Review → Engineering PoC
→ QA → Empfehlung → (bei erheblicher Änderung) Freigabe durch Luigi → Produktion
```

- Nur offizielle Quellen. Eine Quelle, die nicht erreichbar ist, wird als BLOCKED markiert und nicht aus dem Gedächtnis ergänzt.
- Der Radar kauft, installiert und aktiviert **nichts**.
- Er läuft **manuell** auf Anfrage („Welche neuen KI-Möglichkeiten gibt es?“). Es gibt keinen Cron, siehe Kosten-Policy.

## Erster Lauf (06.10.2026, Parallelitätstest G2), Zusammenfassung

Verifiziert über offizielle Claude-Code-Doku:
- Projekt-Subagenten (`.claude/agents`) werden mitten in der Session nachgeladen. Wird das Verzeichnis
  erstmals angelegt, ist ein Neustart nötig.
- Subagenten können Subagenten starten (bis 3 Ebenen, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`).
- Die Hauptsession kann als benannter Agent laufen (`claude --agent <name>` oder `"agent"` in den Settings).
- Ein PreToolUse-Hook blockiert per Exit-Code 2 oder per JSON `permissionDecision` (deny/allow/ask/defer).

Konsequenzen für die Foundation: Der Cloud CEO kann künftig per `claude --agent cloud-ceo` als
Hauptsession laufen (PoC empfohlen). Die flache Delegation ist eine bewusste Entscheidung, keine technische Grenze.

Unverifiziert, weil die Quellen in der Agent-Umgebung blockiert waren: GitHub-Changelog, Render-Changelog,
Lexware-API-Doku. Zum Nachholen müssen die Domains in den Netzwerkeinstellungen der Umgebung freigegeben werden.
