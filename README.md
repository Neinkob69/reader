# Fastreading

Schnelllesen am iPhone per RSVP (Rapid Serial Visual Presentation): Wörter erscheinen
einzeln in der Bildschirmmitte, der rote Fokusbuchstabe (ORP) bleibt dabei immer an
derselben Stelle stehen.

Fastreading ist eine rein statische Web-App. Alle Dateien werden direkt auf dem iPhone
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

**📄 Öffnen** bietet drei Wege:

- **Bibliothek**: alle bisher geöffneten Bücher und Texte, mit Fortschritt und Lesestatistik
- **Datei öffnen**: EPUB, PDF, Word (DOCX), TXT oder HTML, z. B. aus *Dateien → Downloads*
- **Text einfügen**: kopierten Text aus einer beliebigen App oder Webseite einfügen

Danach irgendwo auf den Bildschirm tippen.

| Aktion | Geste |
| --- | --- |
| Lesen starten / pausieren | Irgendwo auf den Bildschirm tippen |
| Satz vor / zurück | Nach links / rechts wischen (auch während des Lesens) |
| Schneller / langsamer | Nach oben / unten wischen (±25 WPM) |
| Satz als Lesezeichen speichern | Finger auf dem Text halten |
| Zu einem Wort springen | Im Pausenmodus ein Wort im Kontext antippen |
| Kapitel & Lesezeichen | Auf den Titel unten tippen (☰) |
| Im Dokument springen | Fortschrittsbalken antippen oder ziehen |
| Desktop | `Leertaste` Start/Pause, `←`/`→` Satz, `↑`/`↓` Tempo, `B` Lesezeichen |

Neue Bücher starten beim eigentlichen Text, Titelei und Inhaltsverzeichnis werden
übersprungen. Unten stehen das aktuelle Kapitel und die Restzeit im Kapitel, rechts die
Restzeit im Buch. Beim Pausieren erscheint der Absatz rund um das aktuelle Wort.

## Wo werden meine Daten gespeichert?

**Nur auf deinem Gerät.** GitHub Pages liefert ausschließlich die App-Dateien aus, es gibt
keinen Server, keine Datenbank und kein Konto. Bücher, Leseposition, Lesezeichen,
Einstellungen und Statistik liegen im Browser-Speicher (IndexedDB/localStorage) der App
auf deinem iPhone.

- Wer deinen Link öffnet, bekommt eine leere App mit eigenem Speicher auf dem eigenen
  Gerät. Niemand sieht deine Bücher, und du siehst keine fremden. Ein Passwort ist nicht
  nötig.
- Die App vom Home-Bildschirm und Safari haben auf iOS getrennte Speicher. Lies am besten
  immer über das Home-Bildschirm-Icon.
- Löschst du die App vom Home-Bildschirm oder die Website-Daten in den Einstellungen, ist
  die Bibliothek weg. Es gibt keine Synchronisierung zwischen Geräten.

## Einstellungen (⚙️)

- **Anzeige**: Farbschema (Auto, Dunkel, Schwarz für OLED, Hell, Sepia), Schrift
  (Standard, Serif, Rund, Mono, Atkinson Hyperlegible), Schriftgröße 70–150 %,
  Schriftstärke, Fokusfarbe, Fokuslinien, Kontext beim Pausieren
- **Lesen**: bis zu 2 oder 3 kurze Wörter pro Anzeige (Chunk-Modus), Pause am
  Kapitelende, Tempo-Training (steigert das Tempo jede Lese-Minute bis zum Ziel)

## Lesezeichen & Zitate

Finger auf dem Text halten speichert den aktuellen Satz. Unter ☰ → *Lesezeichen* stehen
alle gespeicherten Sätze mit Kapitel und Position. Antippen springt hin, **↗ Teilen**
exportiert alle als Text (z. B. in Notizen).

## Lesestatistik

In der Bibliothek unter *Statistik*: Wörter und Lesezeit heute und in den letzten 7 Tagen,
Serie, durchschnittliches Tempo, Gesamtwerte, fertig gelesene Bücher und ein Diagramm der
letzten 14 Tage.

## iOS-Kurzbefehl: Text direkt an Fastreading schicken

Fastreading öffnet Text, der im Link nach `#text=` steht, z. B.
`https://neinkob69.github.io/reader/#title=Artikel&text=Hallo%20Welt`. Der Teil nach `#`
wird nie an einen Server geschickt.

Kurzbefehl anlegen (Kurzbefehle-App → **+**):

1. Im Kurzbefehl-Info **„Im Share-Sheet anzeigen“** aktivieren, Eingabe: *Text* und
   *Safari-Webseiten*.
2. Für Webseiten: Aktion **„Artikel von Webseite abrufen“**, danach **„Details von Artikel
   abrufen“** → *Text*. Für markierten Text entfällt dieser Schritt.
3. Aktion **„URL codieren“** (engl. *URL Encode*) auf den Text anwenden.
4. Aktion **„URL öffnen“** mit `https://neinkob69.github.io/reader/#text=` plus dem
   codierten Text als Variable.

Danach erscheint der Kurzbefehl im Teilen-Menü von Safari und anderen Apps. Die Namen der
Aktionen können je nach iOS-Version leicht abweichen. Links aus Kurzbefehlen öffnet iOS in
Safari, nicht in der Home-Bildschirm-App, der Text landet also in Safaris eigener
Bibliothek. Soll er in die Home-Bildschirm-App, lass den Kurzbefehl den Text stattdessen
kopieren (*„In Zwischenablage kopieren“*) und nutze in der App *Text einfügen → 📋 Einfügen*.

## Kapitel

Die Kapitelansicht nutzt das offizielle Inhaltsverzeichnis des Buchs:

| Format | Quelle der Kapitel |
| --- | --- |
| EPUB | Inhaltsverzeichnis (EPUB 3 `nav` oder EPUB 2 NCX), sonst Überschriften |
| PDF | Lesezeichen, sonst Überschriften (an der größeren Schrift erkannt) |
| Word | Formatvorlagen „Überschrift 1–3“ |
| HTML | Überschriften `h1`–`h3` |
| TXT / eingefügt | Zeilen wie „Kapitel 3“, „CHAPTER IV“, „Prolog“ |

## Was automatisch übersprungen wird

Gelesen wird nur der Fließtext. Alles andere wird ausgelassen:

- Inhaltsverzeichnisse und Register (in EPUBs auch, wenn sie nicht als solche markiert
  sind, in PDFs Seiten mit „Kapitel 3 ...... 41“-Zeilen)
- Bilder, Videos, Audio, Animationen (SVG/Canvas) und interaktive Elemente samt deren
  Ersatztexten wie „Ihr Gerät unterstützt kein Video“
- Bildunterschriften, Fußnoten und Fußnotenverweise
- In PDFs: Diagrammbeschriftungen, Zahlenkolonnen, Seitenzahlen sowie wiederkehrende
  Kopf- und Fußzeilen
- Bei gespeicherten Webseiten: Navigation, Seitenleisten und Fußbereich
- Bei TXT von Project Gutenberg: der Lizenztext vor und nach dem Buch

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `index.html` | Oberfläche und RSVP-Engine (Vanilla HTML/CSS/JS, kein Build-Schritt) |
| `extract.js` | Textextraktion aller Formate, wird erst beim Öffnen geladen |
| `sw.js` | Service Worker für den Offline-Betrieb |
| `vendor/pdfjs/` | [pdf.js](https://github.com/mozilla/pdf.js) 6.4.299 (Apache-2.0) |
| `vendor/fonts/` | [Atkinson Hyperlegible](https://brailleinstitute.org/freefont) (SIL OFL 1.1) |

- **EPUB/DOCX**: Entpacken mit der eingebauten `DecompressionStream`-API. EPUB-Kapitel
  in Lesereihenfolge (Spine), ohne Inhaltsverzeichnis. Weiche Trennstriche werden
  entfernt, DRM-geschützte Bücher werden erkannt.
- **PDF**: pdf.js liefert Textschnipsel mit Position. Daraus werden Zeilen und Absätze
  rekonstruiert (Leerraum, Einrückung, Schriftgröße, Spaltenwechsel). Silbentrennung
  wird zusammengefügt, auch über Seitenumbrüche hinweg; „Ost-West“ bleibt erhalten.
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

- **Kindle-Formate (MOBI/AZW)** werden nicht unterstützt. Die meisten Seiten bieten
  dasselbe Buch auch als EPUB an.
- **Text in Bildern** lässt sich nicht lesen (keine OCR): gescannte PDFs, DjVu, Comics
  und Bilderbücher im Fixed-Layout.
- **DRM-geschützte E-Books** (z. B. gekauft bei Apple Books oder Kindle) lassen sich
  nicht öffnen.
- Updates der App werden ab dem übernächsten Öffnen aktiv (der Service Worker
  aktualisiert im Hintergrund).

## Lokal entwickeln

```bash
python3 -m http.server 8000
```

Dann `http://localhost:8000` öffnen (Service Worker und Wake Lock funktionieren auf
`localhost` auch ohne HTTPS).
