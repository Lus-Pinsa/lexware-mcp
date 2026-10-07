# Persistence Security Contract (verbindlich für Phase 2 · PR 3)

Status: **verbindlich**, noch nicht implementiert. Basis: Security Architecture Gate, `main` = `8f938aa`.
Jede Anforderung hat eine ID (`P-xx`). PR 3 muss jede MUSS-Anforderung mit Test oder Nachweis belegen (Datei:Zeile). Eine Abweichung braucht eine Owner-Entscheidung, die im PR dokumentiert ist.

**Leitsatz: Persistence heißt nicht „alles speichern“.** Gespeichert wird nur, was für einen benannten Zweck nötig ist, und nur so lange, wie der Zweck besteht.

## 0. Vorbedingungen (vor der ersten Zeile Code)

| ID | Anforderung |
|---|---|
| P-00 | **Kostenentscheidung durch Luigi.** Render-Instanzen haben ein flüchtiges Dateisystem. Dauerhafte Speicherung braucht eine Persistent Disk oder eine verwaltete Datenbank, und beides kostet. Ohne Freigabe gibt es keine Persistence. |
| P-01 | **Datenkatalog vor Schema.** Jede zu speichernde Feldgruppe wird mit Zweck, Klasse nach `../data-classification.md`, Quelle, Aufbewahrungsfrist und Löschweg in einer Tabelle im PR dokumentiert. Felder ohne Zweck werden nicht gespeichert. |
| P-02 | **Read-only-Grenze bleibt.** Persistence speichert lokal abgeleitete Daten, z. B. Snapshots, Analyse-Ergebnisse und Webhook-Ereignisse. Sie erzeugt **keinen** Schreibpfad zu Lexware. `PRODUCTION_WRITE_TOOLS` bleibt unverändert. |
| P-03 | **Tenant-Modell zuerst.** Das Schema folgt `multi-tenant-security-contract.md` ab dem ersten Commit. Ein nachträgliches Nachrüsten ist nicht zulässig. |

## 1. Datenminimierung

| ID | Anforderung |
|---|---|
| P-10 | MUSS: Keine vollständigen PDF-Dateien und keine extrahierten PDF-Volltexte speichern. Erlaubt sind Hash (SHA-256), Größe und MIME-Typ, wenn ein Zweck dokumentiert ist, etwa die Dublettenprüfung. |
| P-11 | MUSS: Keine Kontakt-Stammdaten (Namen, Adressen, E-Mails, IBANs) speichern, außer ein dokumentierter Zweck verlangt es. Bevorzugt wird die Lexware-ID als Referenz, und Namen werden bei Bedarf live gelesen. |
| P-12 | MUSS: Keine Secrets in der Anwendungs-DB: keine API-Keys, keine OAuth-Access- oder Refresh-Tokens im Klartext. Werden Tokens später doch gespeichert, dann nur verschlüsselt mit separatem Schlüssel und mit eigener Owner-Freigabe. |
| P-13 | MUSS: Beträge in Cent als Ganzzahl. Qualitätsangaben (STRUCTURED, DERIVED, UNVERIFIED, PLACEHOLDER, CONFLICT, MISSING) werden mitgespeichert. MISSING wird nie zu 0, und UNVERIFIED wird nie still zu VERIFIED. |
| P-14 | SOLL: Aggregate statt Einzelbelegen speichern, wo der Zweck es erlaubt, z. B. Monatssummen je Kategorie. |

## 2. Transport und Ruhe

| ID | Anforderung |
|---|---|
| P-20 | MUSS: Verschlüsselung im Transport. DB-Verbindungen laufen über TLS (`sslmode=verify-full` oder gleichwertig mit Zertifikatsprüfung). Kein Klartext-Fallback. |
| P-21 | MUSS: Verschlüsselung in Ruhe. Die Plattform-Verschlüsselung (Disk oder Managed DB) ist Pflicht. FINANCIAL- und PERSONAL-DATA-Felder, die über Zähler und Hashes hinausgehen, werden zusätzlich auf Anwendungsebene verschlüsselt (AES-256-GCM, zufällige Nonce, Schlüssel aus dem Secret-Store, Schlüssel-ID im Datensatz). |
| P-22 | MUSS: Schlüssel liegen nie im Repository, nie in der DB und nie im Log. Eine Schlüsselrotation ist ohne Datenverlust möglich: Neuverschlüsselung im Hintergrund, alte Schlüssel-ID weiter lesbar bis zur Migration. |
| P-23 | MUSS (Datei-basiert, z. B. SQLite auf einer Disk): Dateirechte `0600`, Verzeichnis `0700`, Eigentümer ist der Laufzeit-User `node` (nicht root). Der Pfad liegt außerhalb des App-Verzeichnisses und des Docker-Build-Kontexts. |

## 3. Berechtigungen

| ID | Anforderung |
|---|---|
| P-30 | MUSS: Getrennte DB-Rollen. Die Migrationsrolle hat DDL-Rechte. Die Laufzeitrolle hat nur DML auf eigene Tabellen: kein DDL, kein `SUPERUSER`, kein Zugriff auf andere Schemas. |
| P-31 | MUSS: Die Laufzeitrolle darf keine Audit-Einträge ändern oder löschen, nur anhängen (`INSERT`). |
| P-32 | MUSS: Datenbank-Credentials sind SECRET. Sie liegen nur im Render-Secret-Store und haben je Umgebung eigene Werte. |
| P-33 | MUSS: Keine dynamisch zusammengesetzten SQL-Strings, nur parametrisierte Queries oder Query-Builder. Ein Test prüft das statisch, analog zum Finance-Policy-Test. |

## 4. Schema, Migration und Integrität

| ID | Anforderung |
|---|---|
| P-40 | MUSS: Versionierte, vorwärts gerichtete Migrationen im Repository. Die Schema-Version steht in der DB. Die App startet nicht, wenn die DB-Version unbekannt oder neuer als der Code ist (Fail closed). |
| P-41 | MUSS: Migrationen laufen in einer Transaktion. Bei einem Fehler bleibt der alte Stand erhalten. Destruktive Migrationen (DROP, Spaltenentfernung) brauchen eine Owner-Freigabe und ein vorheriges verifiziertes Backup. |
| P-42 | MUSS: Integritätsregeln in der DB: `NOT NULL`, `CHECK` für Qualitätsenums und Cent-Bereich (sichere Ganzzahl), `FOREIGN KEY`, `UNIQUE (tenant_id, …)`. |
| P-43 | MUSS: Datensätze aus externen Quellen tragen Herkunft (Quelle, Abrufzeit, Request-Budget-Status) und den PR-1-Qualitätsstatus. |

## 5. Schreiben, Korruption und Wiederanlauf

| ID | Anforderung |
|---|---|
| P-50 | MUSS: Atomare Schreibvorgänge. Ein logischer Vorgang (Snapshot inklusive Positionen) ist eine Transaktion. Bei Dateien gilt: in eine temporäre Datei schreiben, `fsync`, dann `rename`. Halbe Schreibvorgänge dürfen nie als gültige Daten gelesen werden. |
| P-51 | MUSS: Idempotenz. Webhook-Ereignisse und Snapshots haben einen eindeutigen Schlüssel (`tenant_id` plus Ereignis- bzw. Snapshot-ID). Eine Wiederholung erzeugt keine Dublette. |
| P-52 | MUSS: Korruptionserkennung beim Start: Integritätsprüfung (`PRAGMA integrity_check` bzw. eine DB-native Prüfung) und eine Prüfsumme je Snapshot. Bei Fehlern startet die App im Read-only-Modus ohne Persistence-Funktionen und meldet ROT. Sie repariert nicht still. |
| P-53 | MUSS: Absturz und Neustart. Nach einem Kill zu jedem Zeitpunkt ist die DB konsistent (WAL oder Transaktionen). Ein Test simuliert den Abbruch zwischen den Schritten. |
| P-54 | MUSS: Neustart der Plattform. Nach einem Render-Redeploy oder -Restart sind die Daten vorhanden, oder der Verlust wird erkannt und als „Daten nicht verfügbar“ gemeldet. Ein leerer Zustand wird nie als „keine Ereignisse“ gemeldet. |
| P-55 | MUSS: Grenzen. Pro Tenant gibt es eine maximale Anzahl Snapshots, Ereignisse und eine maximale Bytegröße. Beim Überschreiten wird abgelehnt und gemeldet; es wird nicht still verworfen. |

## 6. Backup, Restore und Restore-Verifikation

| ID | Anforderung |
|---|---|
| P-60 | MUSS: Ein Backup-Verfahren ist dokumentiert und automatisiert: Häufigkeit, Aufbewahrung und Speicherort. Backups sind verschlüsselt und liegen getrennt von der Laufzeitumgebung. Die Kosten entscheidet der Owner (P-00). |
| P-61 | MUSS: Ein Restore-Runbook in `incident-response.md` oder im Persistence-PR. |
| P-62 | MUSS: Restore-Verifikation. Ein Test oder Skript stellt ein Backup in einer leeren Instanz wieder her und prüft Schema-Version, Integritätsprüfung, Anzahl je Tabelle und Prüfsummen. Ohne erfolgreiche Restore-Probe darf ein Backup nicht als „vorhanden“ gemeldet werden. |
| P-63 | SOLL: Eine Restore-Probe vor jeder destruktiven Migration. |

## 7. Aufbewahrung und Löschung

| ID | Anforderung |
|---|---|
| P-70 | MUSS: Jede Tabelle hat eine dokumentierte Aufbewahrungsfrist. Vorschlag: abgeleitete Snapshots 90 Tage, Webhook-Ereignisse 30 Tage nach Bestätigung, Audit-Trail 1 Jahr. Die Werte entscheidet der Owner. Gesetzliche Aufbewahrung (GoBD) bleibt in Lexware, der Server ist kein Archiv. |
| P-71 | MUSS: Die Löschung läuft automatisch (Job beim Start oder täglich, ohne externen kostenpflichtigen Scheduler) und ist nachweisbar (Audit-Eintrag mit Anzahl, ohne Inhalte). |
| P-72 | MUSS: Tenant-Löschung. Alle Daten eines Tenants sind vollständig löschbar, ein Test belegt das. Backups laufen über ihre Frist aus, das wird dokumentiert. |
| P-73 | MUSS: Ein Auskunfts- und Löschpfad für personenbezogene Daten (DSGVO Art. 15/17), falls PERSONAL DATA gespeichert wird. |

## 8. Audit-Trail

| ID | Anforderung |
|---|---|
| P-80 | MUSS: Append-only-Audit für sicherheitsrelevante Vorgänge: Schema-Migration, Restore, Löschjobs, Tenant-Anlage und -Löschung, Ablehnungen wegen Tenant-Mismatch, Integritätsfehler. |
| P-81 | MUSS: Audit-Einträge enthalten Zeitpunkt, Tenant, Akteur (Auth-Subjekt als gesalzener Hash, keine E-Mail), Vorgang, Ergebnis und Anzahl. Sie enthalten **keine** FINANCIAL-Inhalte, keine PII im Klartext und keine Secrets. |
| P-82 | SOLL: Hash-Verkettung der Audit-Einträge (jeder Eintrag enthält den Hash des Vorgängers), damit Manipulation erkennbar wird. |

## 9. Lesen und Ausgabe

| ID | Anforderung |
|---|---|
| P-90 | MUSS: Gespeicherte Fremdtexte (Lieferantennamen, Belegnummern) bleiben auch nach dem Laden `untrusted`. Ausgabegrenzen und die «»-Zitierung aus PR 2 gelten weiter. |
| P-91 | MUSS: Ausgaben aus der Persistence kennzeichnen ihr Alter (Stand und Abrufzeit). Veraltete Daten werden nie als aktuell ausgegeben. |
| P-92 | MUSS: Logs enthalten nur Zähler und Fehlerklassen (siehe `../data-classification.md`). Es gibt eine zentrale Redaction-Funktion mit Test. |

## 10. Abnahme für PR 3

PR 3 ist nur abnahmefähig, wenn Folgendes vorliegt:
1. Der Datenkatalog nach P-01.
2. Eine Testmatrix, die jede MUSS-Anforderung abdeckt, mit Gegenprobe gegen den Stand vor der Implementierung.
3. Das unabhängige Review-Verfahren: Security Auditor, Adversarial Tester (Tenant-Ausbruch, Korruption, Restore) und Final Auditor.
4. Die Kostenfreigabe P-00.
