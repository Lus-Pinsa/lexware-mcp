# LU'S — Finance-Regeln (Phase 1: nur lesen)

Kundenspezifische Regeln für das Finance Board. Das Core-Framework kennt diese Regeln nicht;
es liest sie aus dieser Datei.

## Source of Truth

- **Lexware Office** ist die einzige Wahrheit für Belege, Zahlungen, Status und Kategorien.
- Die **Pending Queue** im lexware-mcp liegt im RAM. Sie ist nur ein Hinweis und kann nach einem
  Restart oder Redeploy leer sein. Das ist z. B. beim Render-Free-Tier nach Inaktivität möglich (nicht verifiziert).
- `reconcile-recent-vouchers` gleicht Lexware-`createdDate` mit den `resourceId`s in der Queue ab.
  Ein **reconciliationCandidate beweist nichts**: weder einen fehlgeschlagenen Webhook noch einen
  ungeprüften Beleg.

## Bestehende Read-Pipeline (live getestet, read-only)

```
Pending Queue → Reconciliation → Voucher → Original-PDF → SHA-256 → Positionen
→ Steuerprüfung → Dublettenprüfung → GRÜN / GELB / ROT
```

| Schritt | Tool | Schreibt? |
|---|---|---|
| Queue lesen | `get-pending-voucher-events` | nein |
| Abgleich | `reconcile-recent-vouchers` | nein |
| Beleg | `get-voucher` | nein |
| Original-PDF, Text, Seiten, SHA-256 | `get-voucher-file-text` | nein |
| Queue-Eintrag quittieren | `acknowledge-voucher-event` | nur lokale RAM-Queue, nicht Lexware. In Phase 1 nur nach Freigabe durch Luigi (`ask`-Regel). |

## Dubletten

- **Gleicher SHA-256** heißt: Die Datei ist byteidentisch. Das ist eine technische Dublette.
- **Unterschiedlicher SHA-256** heißt nicht automatisch, dass es ein anderer Geschäftsvorfall ist.
  Lieferant, Rechnungsnummer, Datum und Betrag vergleichen. So wird eine fachliche Dublette erkannt.

## Ampel

| Status | Bedeutung |
|---|---|
| GRÜN | Beleg, PDF, Positionen, Steuer und Summe stimmen überein. Keine Dublette. Der Nachweis kommt aus Tool-Reads. |
| GELB | Etwas ist unklar oder fehlt, z. B. leere `voucherItems`, OCR nötig, ein Kandidat aus der Reconciliation oder eine abweichende Kategorie. |
| ROT | Widerspruch: Summe oder Steuer weicht ab, es gibt eine fachliche oder technische Dublette, oder der Beleg ist überfällig und unklar. |

## Verboten in Phase 1 (technisch blockiert)

Belege buchen, ändern, hochladen oder löschen. Kategorien setzen. Zahlungen. Kassenbuch.
Finalisieren. Webhook-Änderungen. Kontakte oder Artikel anlegen. Siehe
`.claude/settings.json`, `.claude/hooks/guard.mjs` und `ai-company/policies/finance-write-gates.md`.

## Datenschutz

Belegdaten wie Beträge, Lieferanten, IDs und PDF-Inhalte werden **nie** in Repository-Dateien
geschrieben, denn das Repository ist öffentlich. Ergebnisse gehen nur in den Chat mit Luigi.
