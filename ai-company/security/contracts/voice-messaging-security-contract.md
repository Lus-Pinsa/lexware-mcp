# WhatsApp / Voice Security Contract

Status: **verbindlich für jede künftige Messaging- oder Telefonie-Anbindung**. Heute ist nichts davon implementiert.
Basis: Security Architecture Gate, `main` = `8f938aa`.

**Grundregel: Ein Kanal, der eine Stimme oder eine Chat-Nachricht entgegennimmt, ist ein Kanal mit niedriger Vertrauensstufe.** Ein Absender lässt sich fälschen (Caller-ID-Spoofing, SIM-Swap, übernommenes WhatsApp-Konto), eine Stimme lässt sich klonen, und Nachrichten können Prompt-Injection enthalten.

> **Niemals: telefonisches „Ja“ → Banküberweisung.**
> Auch nicht: Chat-„OK“ → Buchung, Zahlung, Finalisierung, Löschung, Bestellung, Preisänderung oder Kundenkontakt.

## Erlaubte Fähigkeiten

| Stufe | Beispiele | Über WhatsApp/Voice |
|---|---|---|
| **Lesen** | Daily Brief, offene Posten, Status einer Prüfung | ✅ nach Identitätsprüfung (V-01) |
| **Analysieren** | „Gibt es Dubletten im September?“ | ✅ nach Identitätsprüfung |
| **Aktion vorbereiten** | Entwurf einer Antwort, Vorschlag einer Buchung als *Vorschlag* | ✅ Ergebnis ist ein Vorschlag mit ID; ausgeführt wird nichts |
| **Aktion ausführen (reversibel, nicht finanziell)** | Erinnerung setzen, eine Aufgabe intern als erledigt markieren | ⚠️ nur mit Re-Authentifizierung (V-02) und Audit |
| **Finanziell oder irreversibel** | Zahlung, Buchung, Finalisierung, Löschung, Lieferantenbestellung, Kundenkontakt, Preisänderung | ❌ nicht im selben Kanal. Ausführung nur über einen unabhängigen, starken Bestätigungskanal (V-03) mit Transaktionssignatur (V-04). In Phase 1 und 2 gilt sowieso: keine Lexware-Writes und keine Zahlungen. |

## Anforderungen

| ID | Anforderung |
|---|---|
| V-01 | **Identitätsprüfung.** Telefonnummer und WhatsApp-Absender gelten nur als *Hinweis*, nicht als Identität. Lesen setzt eine gebundene Identität voraus: ein verifiziertes Gerät bzw. eine Nummer aus einer serverseitigen Allowlist pro Tenant **und** einen Kanal-Login mit Ablauf (z. B. ein Einmal-Link in eine authentifizierte Web-Session, die das Konto bindet). Unbekannte Absender bekommen keine Daten. |
| V-02 | **Re-Authentifizierung.** Vor jeder zustandsändernden Aktion erfolgt eine frische Authentifizierung über einen starken Faktor (Passkey/WebAuthn oder TOTP in der App bzw. im Dashboard), höchstens 5 Minuten alt. Ein Sprach-PIN oder eine Stimmerkennung allein reicht nie. |
| V-03 | **Bestätigungskanal.** Finanzielle und irreversible Aktionen werden in einem **anderen** Kanal bestätigt als dem, in dem sie angestoßen wurden, z. B. im authentifizierten Dashboard mit Passkey. Die Bestätigungsseite zeigt die vollständigen, aus Strukturdaten gerenderten Details (Betrag, Empfänger, IBAN-Endung, Fälligkeit) und keinen LLM-Freitext. |
| V-04 | **Transaktionssignatur.** Die Bestätigung signiert einen kanonischen Hash der Aktion (Tenant, Aktionstyp, alle Parameter, Ablaufzeit, Nonce) mit dem Faktor des Nutzers (WebAuthn-Challenge = Hash). Der Server führt nur aus, wenn der signierte Hash exakt der auszuführenden Aktion entspricht (What You See Is What You Sign). |
| V-05 | **Replay-Schutz.** Jede vorbereitete Aktion hat eine eindeutige ID, eine Nonce und ein Ablaufdatum (z. B. 10 Minuten). Sie ist genau einmal ausführbar; eine Wiederholung wird abgelehnt. Eingehende Kanal-Nachrichten werden über die Message-ID dedupliziert und nach Zeitstempel verworfen, wenn sie zu alt sind. Webhook-Signaturen des Anbieters werden geprüft. |
| V-06 | **Audit-Logging.** Jede Anfrage, jede Vorbereitung, Bestätigung, Ablehnung und Ausführung wird append-only protokolliert (Persistence-Vertrag P-80 bis P-82). Protokolliert werden Kanal, Identitätsstufe, Aktions-Hash und Ergebnis, aber keine Gesprächsinhalte mit FINANCIAL- oder PII-Daten. |
| V-07 | **Prompt-Injection.** Nachrichteninhalt ist `untrusted`. Er kann keine Tools auslösen, die über das Lesen hinausgehen. Ein Kanal-Agent hat nur Read-Tools und das Tool „Aktion vorbereiten“, und zwar per Konfiguration (Tool-Allowlist), nicht per Prompt. |
| V-08 | **Ausgabe-Minimierung.** Antworten in Messaging-Kanälen enthalten nur das Nötige: keine vollständigen IBANs, keine Belegdateien, keine Kontaktlisten. Sprachausgaben nennen Beträge nur nach erfolgreicher Identitätsprüfung (V-01). |
| V-09 | **Anbieter.** WhatsApp Business API und Telefonie sind externe, kostenpflichtige Dienste. Ihre Anbindung braucht eine Owner-Freigabe (Kosten, AVV/DSGVO, Datenstandort). Anbieter-Tokens sind SECRET und liegen nur im Secret-Store. |
| V-10 | **Notfall.** Der Kanal ist per Konfiguration sofort abschaltbar (Kill-Switch). Bei Verdacht auf Missbrauch werden alle offenen vorbereiteten Aktionen verworfen (siehe `../incident-response.md`). |
| V-11 | **Aufbewahrung beim Anbieter.** Aufnahmen, Transkripte und Nachrichten beim Kanal-Anbieter haben eine dokumentierte, minimale Frist (Standard: keine Aufnahme, Transkripte höchstens 30 Tage), mit Löschweg und Auftragsverarbeitungsvertrag. |

## Abnahme

Eine künftige Kanal-Anbindung ist nur abnahmefähig mit:
- Tests für V-01 bis V-07, darunter: gefälschter Absender, Replay einer Bestätigung, abgelaufene Nonce, geänderter Betrag nach der Signatur, Prompt-Injection im Nachrichtentext.
- Einem unabhängigen Security Audit.
- Einer Owner-Freigabe.
