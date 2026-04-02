# Thalamus Framework — KI-Infrastruktur nach dem Vorbild des menschlichen Gehirns

> Wir haben nicht Software-Patterns gefolgt. Wir haben dem Gehirn gefolgt.

---

## Die Geschichte

Ein Unternehmer. Ein KI-Assistent. Ein 30€/Monat Server.

Was als Telegram-Bot begann, wurde ein vollständig autonomes Multi-Agenten-System,
das Software plant, baut, testet und reviewed — ohne menschliches Eingreifen.

Vier KI-Agenten koordinieren sich in Echtzeit über binäre Signale. Eine nächtliche
"Traumroutine" konsolidiert das Gedächtnis. Eine "Amygdala" verhindert, dass vergangene
Fehler wiederholt werden. Ein Schwarm ephemerer Worker baut ganze Services autonom um.

Dieses Repository erklärt wie es funktioniert, warum es dem menschlichen Gehirn
nachempfunden ist, und enthält eine vereinfachte Referenz-Implementierung zum Ausprobieren.

---

## Die Gehirn-Architektur (8 Schichten)

```
NEST (Schicht 8) ─────────────────────────────────────
  │
  ├── Agent A ────── Agent B ────── Agent C
  │          ↘          ↓          ↙
  │           [  THALAMUS (Schicht 4b)  ]
  │                     │
  │          ┌──────────┴──────────┐
  │     Hippocampus          Neokortex
  │     (Schicht 2)          (Schicht 3)
  │     Kurzzeit-DB          Langzeit-DB
  │
  ├── Failsafe (Schicht 5) — keine Arbeit geht verloren
  ├── Amygdala (Schicht 6) — kein Fehler wird wiederholt
  └── Traumroutine (Schicht 7) — läuft jede Nacht um 3 Uhr
```

| Schicht | Name | Menschliches Gehirn | Unser System |
|---------|------|---------------------|-------------|
| 1 | **Context Window** | Arbeitsgedächtnis | Session-Status, Identität, Regeln |
| 2 | **Hippocampus** | Kurzzeitgedächtnis | Cloud-DB: aktuelle Gespräche, Fakten, Ziele |
| 3 | **Neokortex** | Langzeitgedächtnis | Relationale DB: konsolidiertes Wissen über Monate |
| 4b | **Thalamus** | Signalweiterleitung | IPC-Daemon: kostenlose Koordination zwischen Agenten |
| 5 | **Failsafe** | Überlebensinstinkt | Task-Verträge, Crash-Recovery, Git-Checkpoints |
| 6 | **Amygdala** | Angstgedächtnis | Fehler-Datenbank — wird vor jeder riskanten Aktion geprüft |
| 7 | **Traumroutine** | Schlafkonsolidierung | Nächtlicher Cron: komprimieren, deduplizieren, selbst-reviewen |
| 8 | **NEST** | Neuronales Netzwerk | Multi-Agenten Enterprise OS (14-16 spezialisierte Agenten) |

Jede Schicht löst ein konkretes Problem, das auch Menschen haben.
Die Namensgebung ist kein Schmuck — sie ist eine Design-Philosophie:
**Baue KI-Infrastruktur so, wie die Evolution Intelligenz gebaut hat.**

→ [Vollständige Architektur-Erklärung](docs/brain-architecture.md)

---

## Warum Thalamus alles verändert

Alle großen Multi-Agenten-Frameworks — LangGraph, CrewAI, AutoGen —
koordinieren Agenten über API-Calls. Das kostet Tokens, erzeugt Latenz und bricht unter Last.

Thalamus koordiniert über **lokales IPC**: binäre Signale über Unix Sockets.
Null Tokens. Mikrosekunden Latenz. Agenten wachen autonom auf.

| | Thalamus | LangGraph | CrewAI | AutoGen |
|---|----------|-----------|--------|---------|
| Kommunikation | **IPC (binär)** | API-Calls | API-Calls | API-Calls |
| Token-Kosten | **0** | $$ | $$ | $$ |
| Latenz | **<1ms** | 100ms+ | 100ms+ | 100ms+ |
| Autonomes Aufwecken | **Ja** | Nein | Nein | Nein |
| Loop-Erkennung | **Ja** | Nein | Nein | Nein |
| Circuit Breaker | **Ja** | Nein | Nein | Nein |

→ [Detaillierter Vergleich](docs/comparison.md) | [Thalamus Deep Dive](docs/thalamus-deep-dive.md)

---

## Micro-Agent Swarm

Die wahre Stärke: **ephemere Worker-Agenten** mit spezialisierten Rollen,
die autonom Software durch eine komplette Pipeline entwickeln.

**Pipeline:** `Planner → Builder → Tester → Reviewer → Fix-Schleife`

**8 Rollen:** Planner · Frontend · Backend · Database · Infra · Reviewer · Tester · Debugger

### Echtes Ergebnis (anonymisiert)

Ein HTTP-Mail-Service — komplett neu gebaut von 8 autonomen Workern:

| | Vorher | Nachher |
|---|--------|---------|
| Code-Zeilen | 96 | 190 |
| Input-Validierung | Nur Existenz-Check | E-Mail-Format + Type-Checks |
| Fehler-Antworten | Interne Details sichtbar | Strukturiertes JSON, keine Leaks |
| Rate-Limiting | Keines | 10 Req/Min, gleitendes Fenster |
| Health-Endpoint | Keiner | `GET /health` mit Uptime |
| Logging | `console.log` | Strukturiertes JSON + PII-Masking |

**8 Worker · 8 Minuten · Score 9/10 · 2 Fix-Runden · 0 menschliches Eingreifen**

→ [Wie der Swarm funktioniert](docs/swarm.md) | [Testergebnisse](docs/results.md)

---

## Ausprobieren

```bash
cd example
bash demo.sh
```

→ [Beispiel-Dokumentation](example/README.md)

---

## Das Team

Gebaut von **[KI Force](https://ki-force.de)** — Europäische KI-Transformation.

**Thomas Less** — Unternehmer & Chief Vision Officer
München, Deutschland · Ehemaliger Head of New Media bei Siemens (26 Länder)
Baut heute autonome KI-Infrastruktur für den europäischen Mittelstand.

[LinkedIn](https://www.linkedin.com/in/thomas-less-49263454/) · [KI Force](https://ki-force.de)

---

## Produktionsversion

→ **[Interesse? Sprechen wir darüber.](https://ki-force.de)** | [Details](COMMERCIAL.md)

---

## Lizenz

MIT — siehe [LICENSE](LICENSE). Produktionssystem unter kommerzieller Lizenz.
