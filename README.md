# Argon RSVP

Schnelllesen von EPUB- und PDF-Dateien am iPhone per RSVP (Rapid Serial Visual
Presentation): Wörter erscheinen einzeln in der Bildschirmmitte, der rote
Fokusbuchstabe (ORP) bleibt dabei immer an derselben Stelle stehen.

Argon ist eine rein statische Web-App. Die Bücher werden direkt auf dem iPhone
ausgelesen und nirgendwohin hochgeladen. Es läuft kein Server, und nach dem ersten
Öffnen funktioniert die App auch offline.

## Einrichten (einmalig)

1. Auf GitHub im Repo: **Settings → Pages → Build and deployment**
   - Source: *Deploy from a branch*
   - Branch: `claude/cool-tesla-3utl1a`, Ordner `/ (root)` → **Save**
2. Nach ca. einer Minute ist die App unter `https://neinkob69.github.io/reader/` erreichbar.
3. Auf dem iPhone in Safari öffnen → *Teilen → Zum Home-Bildschirm*.

GitHub Pages ist im kostenlosen Plan nur für öffentliche Repos verfügbar. Da keine
Bücher im Repo liegen, ist dann nur der Code öffentlich. Alternativ funktioniert jeder
Hoster für statische Seiten (z. B. Cloudflare Pages oder Netlify, auch mit privatem Repo).

## Lesen

1. Buch in Safari herunterladen (landet in *Dateien → Downloads*).
2. Argon öffnen → **📄 Datei** → Buch auswählen.
3. Irgendwo auf den Bildschirm tippen.

| Aktion | Geste |
| --- | --- |
| Lesen starten / pausieren | Irgendwo auf den Bildschirm tippen |
| Zum vorherigen Satzanfang | `↺ Satz` (im Pausenmodus) |
| Im Dokument springen | Fortschrittsbalken antippen oder ziehen |
| Geschwindigkeit | Slider oben (200–1000 WPM) |
| Desktop | `Leertaste` Start/Pause, `←`/`→` Satz zurück/vor, `↑`/`↓` ±25 WPM |

Position, Geschwindigkeit und Theme bleiben erhalten. Das zuletzt geöffnete Buch liegt
lokal in IndexedDB, die Leseposition wird pro Buch gespeichert. Öffnest du ein früheres
Buch erneut, geht es an der alten Stelle weiter.

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `index.html` | Oberfläche und RSVP-Engine (Vanilla HTML/CSS/JS, kein Build-Schritt) |
| `extract.js` | Textextraktion aus EPUB/PDF, wird erst beim Öffnen einer Datei geladen |
| `sw.js` | Service Worker für den Offline-Betrieb |
| `vendor/pdfjs/` | [pdf.js](https://github.com/mozilla/pdf.js) 6.4.299 (Apache-2.0) |

- **EPUB**: Entpacken mit der eingebauten `DecompressionStream`-API. Kapitel in
  Lesereihenfolge (Spine), ohne Inhaltsverzeichnis und Fußnoten. Weiche Trennstriche
  werden entfernt, DRM-geschützte Bücher werden erkannt.
- **PDF**: pdf.js liefert Textschnipsel mit Position. Daraus werden Zeilen und Absätze
  rekonstruiert (Leerraum, Einrückung, Schriftgröße, Spaltenwechsel). Seitenzahlen und
  wiederkehrende Kopf-/Fußzeilen werden entfernt. Silbentrennung wird zusammengefügt,
  auch über Seitenumbrüche hinweg; „Ost-West“ bleibt erhalten.
- **ORP-Anker**: 3-Spalten-Flexbox (links und rechts gleich breit, ORP dazwischen),
  dadurch steht der rote Buchstabe pixelgenau in der Mitte. Zu lange Wörter werden
  verkleinert statt abgeschnitten.
- **Timing**: `requestAnimationFrame` mit absoluten Deadlines, also ohne Drift, auch bei
  120 Hz oder gedrosselten 30 Hz im Stromsparmodus.
- **Pacing**: Satzende ×2, Komma/Semikolon/Gedankenstrich ×1,5, Absatzende ×2,6, Zuschläge
  für Wörter mit mehr als 10 Buchstaben und für Zahlen. Abkürzungen wie „z.B.“ lösen keine
  Satzpause aus, und nach jedem Start laufen die ersten Wörter etwas langsamer an.
- **Display**: Beim Lesen verhindert die Wake-Lock-API, dass sich das iPhone sperrt.

## Grenzen

- Gescannte PDFs ohne Textebene (keine OCR) und DRM-geschützte E-Books (z. B. aus
  Apple Books oder Kindle) werden nicht unterstützt.
- Updates der App werden ab dem übernächsten Öffnen aktiv (der Service Worker
  aktualisiert im Hintergrund).

## Lokal entwickeln

```bash
python3 -m http.server 8000
```

Dann `http://localhost:8000` öffnen (Service Worker und Wake Lock funktionieren auf
`localhost` auch ohne HTTPS).
