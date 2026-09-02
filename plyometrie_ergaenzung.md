# Ergänzung: Plyometrie im Krafttraining (Claude Code Prompt + Textbaustein)

## Prompt für Claude Code

Öffne `Trainingsplan_ab_14_09.md` und ergänze das Krafttraining A/B um ein drittes
Element: dynamische Einbein-Sprünge (Plyometrie). Füge den folgenden Abschnitt
direkt nach dem bestehenden "Krafttraining (ergänzend, Rønnestad-Protokoll)"-Block
ein (vor "## Woche 1–2: Wiedereinstieg / Sweet Spot Basis"), und passe die
Wochentabellen so an, dass bei "Krafttraining A" und "Krafttraining B" ein Hinweis
auf die Sprung-Progression steht (siehe Progressionsplan unten). Committe die
Änderung mit einer aussagekräftigen Commit-Message.

---

## Einzufügender Abschnitt

### Plyometrie-Ergänzung (drittes Element, ab Woche 1)

**Begründung:** Studie (NZ, gut trainierte Radfahrer) kombinierte explosive
Einbein-Sprünge mit hochintensiven Rad-Sprints; Ergebnis: Zugewinne bei Sprint-
und Ausdauerleistung über verbesserte Tretökonomie und Laktatschwelle
(Dehnungs-Verkürzungs-Zyklus, DVZ) – ein Trainingsreiz, den reine
Beinpresse/Kniebeuge nicht abdeckt.

**Platzierung im Training:**
- Sprünge **zu Beginn** der Krafteinheit (A und B), wenn das Nervensystem frisch ist – vor der schweren Beinpresse/Kniebeuge
- Nicht Ersatz, sondern Ergänzung zu den bestehenden 4 Grundübungen

**Dosierung:** 2–3 Sätze × 5–8 Sprünge je Bein. Qualität vor Quantität – Satz
abbrechen, sobald die Sprunghöhe merklich nachlässt.

**Altersgerechte Progression (53 J., Sehnen/Gelenke brauchen mehr Vorbereitung):**

| Woche | Übungsvariante | Amplitude |
|---|---|---|
| 1–2 | Step-ups mit leichtem Absprung | niedrig |
| 3–4 | Countermovement Jumps (CMJ), einbeinig | mittel |
| 5 | Box Jumps oder CMJ, volle Intensität (reduziertes Volumen wie übriges Krafttraining) | hoch |
| 6 | keine Sprünge (Taper vor Retest) | – |

**Ergänzte Übungstabelle:**

| Übung | Sätze × Wdh. | Intensität | Zweck |
|---|---|---|---|
| Beinpresse oder Kniebeuge (Halbtief) | 4 × 4–6 | 85–90% 1RM | Haupt-Kraftreiz |
| Ausfallschritt / Split-Squat | 3 × 6–8 je Seite | schwer | Einbeinige Stabilität & Tretökonomie |
| Hüftstrecker (Hip Thrust / RDL) | 3 × 6–8 | schwer | Hüftstreckerkraft |
| Wadenheben (optional) | 3 × 10–12 | moderat | Zusatzübung |
| **Dynamische Einbein-Sprünge** | **2–3 × 5–8** | **s.o. Progressionstabelle** | **DVZ, Tretökonomie, Sprintfähigkeit** |

---

## Optional: JSON-Import-Schema (Radtraining PWA)

Falls die PWA ein Feld für Übungsvarianten pro Krafttag vorsieht, ergänze analog
`"jumps": {"sets": "2-3", "reps": "5-8", "variant": "step-up|CMJ|box-jump", "week": n}`
im entsprechenden Trainingsblock-JSON. Prüfe zuerst das bestehende JSON-Schema der
PWA, bevor du das Feld hinzufügst, damit die Struktur konsistent bleibt.
