# Security Architecture Gate (vor Phase 2 · PR 3 Persistence)

Status: **in Arbeit**. Basis: `main` = `8f938aa`. Dieser Ordner enthält kein Code-Feature und keinen Persistence-Code.

Geplante Dokumente:

| Dokument | Inhalt |
|---|---|
| `threat-model.md` | Assets, Trust Boundaries, Entry Points, Angreifer, Abuse Cases, Blast Radius, Controls (STRIDE) |
| `attack-surface-audit.md` | Befunde aus Code und Konfiguration mit Schweregrad und Nachweis |
| `data-classification.md` | Klassen PUBLIC … SECRET und was wo erlaubt ist |
| `history-exposure.md` | Öffentliche Git-Historie: Exposure-Analyse und Cleanup-Plan (nicht ausgeführt) |
| `supply-chain-and-platform.md` | npm, GitHub Actions, Rulesets, Render: Soll/Ist und Owner-Aktionen |
| `contracts/persistence-security-contract.md` | Verbindliche Anforderungen für PR 3 |
| `contracts/multi-tenant-security-contract.md` | Tenant-Grenzen |
| `contracts/voice-messaging-security-contract.md` | WhatsApp/Telefon |
| `incident-response.md` | Detect, Contain, Revoke, Rotate, Recover, Audit |
