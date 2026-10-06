# Policy: Review-Loop, Statusregeln und Eskalation

**Referenzimplementierung (deterministisch, getestet):** `ai-company/core/governance.ts`
und `tests/governance.test.ts`.

## Standard-Workflow

```
TASK → TEAM LEAD (Plan + Akzeptanzkriterien) → SPECIALIST → TEST ENGINEER
     → DOMAIN REVIEWER → SECURITY REVIEW → DETERMINISTIC CI → FINAL AUDITOR → PR READY
```

- Bei REQUEST_CHANGES oder ROT geht die Arbeit zurück an den zuständigen Specialist, mit den Findings.
- **Maximal 3 automatische Fix-Runden je Problem.** Danach gilt **BLOCKED**: Blocker dokumentieren,
  Cloud CEO informieren, die erforderliche Entscheidung konkret benennen. Kein Endlos-Loop. Das Limit
  ist im Code gedeckelt: `maxFixRounds` lässt sich nicht über 3 setzen.
- Ein Absturz oder Fehler eines Agenten zählt als gescheiterte Runde. Ein unbekannter Zustand ist nie GRÜN.

## Trennung der Aufgaben

| Risikoklasse | Regel |
|---|---|
| normal | Ersteller ≠ Prüfer |
| kritisch (Finance, HR, HACCP, Security, Auth, Tiers, Dependencies, alles Irreversible) | Ersteller ≠ Prüfer ≠ technisches Gate (CI) |

`assertSeparationOfDuties()` wirft einen Fehler, statt nur `false` zu liefern. So kann ein Aufrufer einen Verstoß nicht übersehen.

## Statusregeln

| Status | Wann |
|---|---|
| GRÜN | Nur mit Nachweis: Testausgabe, CI-Lauf, API-Read, `datei:zeile`. Annahmen zählen nicht. |
| GELB | Unvollständig, unverifiziert, fehlende Daten oder Berechtigungen |
| ROT | Ein Gate oder Test schlägt fehl, ein Reviewer sagt ROT, es gibt Widersprüche |
| BLOCKED | Retry-Limit erreicht oder Entscheidung des Owners nötig |

`certifyStatus()` stuft GRÜN ohne Nachweis automatisch auf GELB herab. Jeder fehlgeschlagene Nachweis ergibt ROT.

## Eskalationsformat (an Cloud CEO, dann an Luigi)

```
BLOCKED: <Aufgabe>
RUNDEN: <n>/3
BLOCKER: <was konkret scheitert, Nachweis>
ENTSCHEIDUNG NÖTIG: <eine konkrete Frage mit Optionen>
```

## Fail closed

Bei Unsicherheit, widersprüchlichen Daten, fehlenden Berechtigungen, nicht bestandenen Tests oder
unbekannten Zuständen gilt: **keine produktive Aktion**. Stattdessen GELB oder ROT, ein klarer
Blocker und die notwendige Entscheidung.
