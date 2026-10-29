# Argon RSVP

Schnelllesen von EPUB- und PDF-Dateien am iPhone per RSVP (Rapid Serial Visual
Presentation): Wörter erscheinen einzeln in der Bildschirmmitte, der rote
Fokusbuchstabe (ORP) bleibt dabei immer an derselben Stelle stehen.

## Starten

```bash
pip install -r requirements.txt
```

```bash
python main.py
```

Das Terminal zeigt die Adresse für das iPhone an (z. B. `http://192.168.1.23:8000`).
iPhone und Rechner müssen im selben WLAN sein.

**Als App installieren:** In Safari auf *Teilen → Zum Home-Bildschirm*. Argon startet
dann im Vollbild ohne Adressleiste.

## Bedienung

| Aktion | Geste |
| --- | --- |
| Lesen starten / pausieren | Irgendwo auf den Bildschirm tippen |
| Zum vorherigen Satzanfang | `↺ Satz` (im Pausenmodus) |
| Im Dokument springen | Fortschrittsbalken antippen oder ziehen |
| Geschwindigkeit | Slider oben (200–1000 WPM) |
| Desktop | `Leertaste` Start/Pause, `←`/`→` Satz zurück/vor, `↑`/`↓` ±25 WPM |

Position, Geschwindigkeit und Theme bleiben nach einem Reload erhalten. Das aktuelle
Dokument wird lokal in IndexedDB zwischengespeichert, die Leseposition pro Dokument
in `localStorage`. Lädst du ein Buch später erneut hoch, geht es an der alten Stelle
weiter.

## Wie es funktioniert

**Backend (`main.py`)**: FastAPI nimmt die Datei entgegen und liefert
`{ words: [...], paragraph_ends: [...] }`.

- EPUB: Kapitel in Lesereihenfolge (Spine), ohne Inhaltsverzeichnis, Fußnoten und
  `<head>`-Titel. Weiche Trennstriche werden entfernt.
- PDF: Seitenzahlen und wiederkehrende Kopf-/Fußzeilen werden entfernt, Silbentrennung
  am Zeilenende wird zusammengefügt (auch über Seitenumbrüche, „Ost-West“ bleibt
  erhalten), Ligaturen (ﬁ, ﬂ) werden aufgelöst.

**Frontend (`static/index.html`)**: Vanilla HTML/CSS/JS, kein Build-Schritt.

- **ORP-Anker**: 3-Spalten-Flexbox (links und rechts gleich breit, ORP dazwischen), so
  steht der rote Buchstabe pixelgenau in der Mitte. Zu lange Wörter werden
  verkleinert statt abgeschnitten.
- **Timing**: `requestAnimationFrame` mit absoluten Deadlines, also ohne Drift, auch
  bei 120 Hz oder gedrosselten 30 Hz im Stromsparmodus.
- **Pacing**: Satzende ×2, Komma/Semikolon/Gedankenstrich ×1,5, Absatzende ×2,6,
  Wörter mit mehr als 10 Buchstaben und Zahlen bekommen Zuschläge. Abkürzungen wie
  „z.B.“ lösen keine Satzpause aus. Nach jedem Start laufen die ersten Wörter etwas
  langsamer an.

## Grenzen

- **Display-Sperre**: Die Wake-Lock-API, die das Display beim Lesen anlässt,
  funktioniert in Safari nur über HTTPS. Bei `http://192.168…` sperrt sich das iPhone
  nach der eingestellten Auto-Sperre. Abhilfe: Auto-Sperre hochsetzen oder HTTPS
  nutzen, z. B. mit `tailscale serve 8000`.
- **Rechner muss laufen**: Das Parsing passiert auf dem Server. Ein bereits geladenes
  Dokument bleibt aber im Cache und lässt sich auch ohne Server weiterlesen, solange
  die Seite geöffnet bleibt.
- Gescannte PDFs ohne Textebene (keine OCR) und DRM-geschützte E-Books werden nicht
  unterstützt.
