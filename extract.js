// Argon – Textextraktion direkt im Browser: EPUB/PDF → Absätze → flaches Wort-Array.
// Alles läuft lokal auf dem Gerät, Bücher werden nirgendwohin hochgeladen.

const PDFJS_URL = new URL('./vendor/pdfjs/pdf.min.js', import.meta.url).href;
const PDFJS_WORKER_URL = new URL('./vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;

export class ExtractionError extends Error {}

// --- Text-Bereinigung & Tokenisierung ---------------------------------------

const LIGATURES = /[ﬀ-ﬆ]/g;
// Unsichtbare Zeichen (v. a. weiche Trennstriche in EPUBs) würden Wörter zerstückeln
const INVISIBLE = /[­​-‍⁠﻿]/g;
const CONTROL_CHARS = /[\x00-\x08\x0E-\x1F\x7F-\x9F]/g;
const LINE_END_HYPHEN = /([\p{L}\p{N}])[-­‐][ \t]*\n\s*([\p{L}\p{N}])/gu;
const DASH_BREAK = /(?<=[–—])(?=[\p{L}\p{N}])/u;
const HYPHEN_BREAK = /(?<=[\p{L}\p{N}]-)(?=[\p{L}\p{N}])/u;
const HAS_ALNUM = /[\p{L}\p{N}]/u;
const LONG_COMPOUND = 24;

const isLower = (ch) => ch !== ch.toUpperCase() && ch === ch.toLowerCase();

function cleanText(raw) {
    return raw
        .normalize('NFC')
        .replace(LIGATURES, (ch) => ch.normalize('NFKC'))
        // "Wissen-\nschaft" → "Wissenschaft", aber "Ost-\nWest" → "Ost-West"
        .replace(LINE_END_HYPHEN, (_, head, tail) => (isLower(tail) ? head + tail : `${head}-${tail}`))
        .replace(INVISIBLE, '')
        .replace(CONTROL_CHARS, '');
}

// Zerlegt einen Absatz in Wörter. Satzzeichen bleiben für das Pacing erhalten.
export function tokenize(paragraph) {
    const words = [];
    for (const token of cleanText(paragraph).split(/\s+/)) {
        if (!token) continue;
        for (const part of token.split(DASH_BREAK)) {
            // Sehr lange Bindestrich-Komposita am Bindestrich aufteilen
            const pieces = part.length > LONG_COMPOUND && part.includes('-')
                ? part.split(HYPHEN_BREAK).filter(Boolean)
                : [part];
            for (const piece of pieces) {
                // Alleinstehende Satzzeichen ("–", "…") ans vorige Wort hängen
                if (words.length && !HAS_ALNUM.test(piece)) words[words.length - 1] += ` ${piece}`;
                else words.push(piece);
            }
        }
    }
    return words;
}

// Flaches Wort-Array plus Index des jeweils letzten Worts eines Absatzes
export function buildDocument(paragraphs) {
    const words = [];
    const paragraphEnds = [];
    for (const paragraph of paragraphs) {
        const tokens = tokenize(paragraph);
        if (!tokens.length) continue;
        for (const token of tokens) words.push(token);
        paragraphEnds.push(words.length - 1);
    }
    return { words, paragraphEnds };
}

// --- PDF ----------------------------------------------------------------------

const PAGE_NUMBER = /^[^\p{L}]*\d[^\p{L}]*$/u;
const SENTENCE_END = /[.!?:…"'»«“”’)\]]$/;
const EDGE_BLOCKS = 2;

// pdf.js liefert einzelne Textschnipsel mit Position; daraus Zeilen und Absatzblöcke bauen
function pageBlocks(items) {
    const lines = [];
    let line = null;
    for (const item of items) {
        if (typeof item.str !== 'string') continue;
        const [, , c, d, x, y] = item.transform;
        const size = item.height || Math.hypot(c, d);
        if (item.str.trim()) {
            if (line && Math.abs(y - line.y) > Math.max(size, line.size) * 0.5) {
                lines.push(line);
                line = null;
            }
            if (!line) {
                line = { text: item.str, x, y, size, end: x + item.width };
            } else {
                // Lücke ohne Leerzeichen zwischen zwei Schnipseln → Wortgrenze
                const gap = x - line.end;
                if (gap > size * 0.15 && !/\s$/.test(line.text) && !/^\s/.test(item.str)) line.text += ' ';
                line.text += item.str;
                line.size = Math.max(line.size, size);
                line.end = x + item.width;
            }
        } else if (line && item.str) {
            line.text += item.str;
        }
        if (item.hasEOL && line) {
            lines.push(line);
            line = null;
        }
    }
    if (line) lines.push(line);

    const blocks = [];
    let block = null;
    for (const ln of lines) {
        const text = ln.text.trim();
        if (!text) continue;
        if (block) {
            const prev = block.last;
            const size = Math.max(prev.size, ln.size);
            const gap = prev.y - ln.y; // > 0: Zeile liegt darunter
            const expectedGap = block.gap ?? size * 1.35;
            const startsNew = gap <= 0                         // Sprung nach oben: neue Spalte
                || gap > expectedGap * 1.4                     // Leerraum zwischen Absätzen
                || Math.abs(prev.size - ln.size) > size * 0.15 // andere Schriftgröße (Überschrift)
                || ln.x > block.left + size * 0.8;             // eingerückte erste Absatzzeile
            if (!startsNew) {
                block.lines.push(text);
                block.gap ??= gap;
                block.last = ln;
                block.left = Math.min(block.left, ln.x);
                continue;
            }
            // flowEnd: Block endet am Spaltenende, nicht vor einem Leerraum
            blocks.push({ text: block.lines.join('\n'), flowEnd: gap <= 0 });
        }
        block = { lines: [text], last: ln, left: ln.x, gap: null };
    }
    if (block) blocks.push({ text: block.lines.join('\n'), flowEnd: true });
    return blocks;
}

// Seitenzahlen in Kopf-/Fußzeilen unkenntlich machen, damit sie als gleich zählen
const edgeKey = (block) => block.text.toLowerCase().replace(/\d+/g, '#');

// Entfernt Seitenzahlen sowie Kopf- und Fußzeilen, die sich auf vielen Seiten wiederholen
function stripRunningHeads(pages) {
    const counts = new Map();
    for (const blocks of pages) {
        const edges = new Set(
            [...blocks.slice(0, EDGE_BLOCKS), ...blocks.slice(-EDGE_BLOCKS)]
                .filter((b) => b.text.length < 120)
                .map(edgeKey),
        );
        for (const key of edges) counts.set(key, (counts.get(key) || 0) + 1);
    }
    const threshold = Math.max(3, pages.length * 0.25);

    return pages.map((blocks) => {
        const body = blocks.filter((block, i) => {
            const atEdge = i < EDGE_BLOCKS || i >= blocks.length - EDGE_BLOCKS;
            const isPageNumber = block.text.length < 15 && PAGE_NUMBER.test(block.text);
            return !(atEdge && (isPageNumber || (counts.get(edgeKey(block)) || 0) >= threshold));
        });
        if (body.length) body[body.length - 1].flowEnd = true; // Seitenende
        return body;
    });
}

// Setzt Blöcke zu Absätzen zusammen, auch über Spalten- und Seitenumbrüche hinweg
function mergePdfBlocks(pages) {
    const paragraphs = [];
    let current = null;
    for (const block of pages.flat()) {
        if (!current) {
            current = { ...block };
            continue;
        }
        const endsSentence = SENTENCE_END.test(current.text);
        // Kurz und ohne Satzende = Überschrift, außer der Block endet nur, weil die
        // Spalte/Seite voll ist ("…sagte seine" | "Nachbarin, als …")
        const looksLikeHeading = current.text.length < 80 && !endsSentence && !current.flowEnd;
        if ((endsSentence || looksLikeHeading) && !isLower(block.text[0])) {
            paragraphs.push(current.text);
            current = { ...block };
        } else {
            // Satz läuft im nächsten Block weiter (Seiten-/Spaltenumbruch)
            current = { text: `${current.text}\n${block.text}`, flowEnd: block.flowEnd };
        }
    }
    if (current) paragraphs.push(current.text);
    return paragraphs;
}

async function extractPdf(buffer, onProgress) {
    const pdfjs = await import(PDFJS_URL);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;

    const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0 });
    let pdf;
    try {
        pdf = await task.promise;
    } catch (err) {
        task.destroy();
        if (err?.name === 'PasswordException') throw new ExtractionError('Das PDF ist passwortgeschützt.');
        throw err;
    }
    try {
        const pages = [];
        for (let n = 1; n <= pdf.numPages; n++) {
            onProgress?.(`Lese Seite ${n} / ${pdf.numPages} …`);
            const page = await pdf.getPage(n);
            const content = await page.getTextContent();
            pages.push(pageBlocks(content.items));
            page.cleanup();
        }
        return { title: null, paragraphs: mergePdfBlocks(stripRunningHeads(pages)) };
    } finally {
        task.destroy();
    }
}

// --- EPUB ---------------------------------------------------------------------

// Minimaler ZIP-Leser über das Inhaltsverzeichnis am Dateiende; entpackt wird mit der
// eingebauten DecompressionStream-API, eine ZIP-Bibliothek ist nicht nötig.
function openZip(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new ExtractionError('Keine gültige EPUB-Datei (ZIP beschädigt).');

    const utf8 = new TextDecoder();
    const entries = new Map();
    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    for (let n = 0; n < count && view.getUint32(offset, true) === 0x02014b50; n++) {
        const nameLength = view.getUint16(offset + 28, true);
        entries.set(utf8.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)), {
            method: view.getUint16(offset + 10, true),
            size: view.getUint32(offset + 20, true),
            localOffset: view.getUint32(offset + 42, true),
        });
        offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    }

    async function read(name) {
        const entry = entries.get(name);
        if (!entry) return null;
        const local = entry.localOffset;
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const data = bytes.subarray(start, start + entry.size);
        if (entry.method === 0) return data;
        if (entry.method !== 8) throw new ExtractionError('Nicht unterstützte ZIP-Kompression im EPUB.');
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    return {
        has: (name) => entries.has(name),
        async text(name) {
            const data = await read(name);
            if (!data) return null;
            if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data);
            if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data);
            return utf8.decode(data);
        },
    };
}

const DC_NS = 'http://purl.org/dc/elements/1.1/';
const BLOCK_TAGS = [
    'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt',
    'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'header', 'hr', 'li', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th',
    'tr', 'ul',
].join(',');
const NOTE_MARKUP = /\b(?:doc-)?(?:noteref|footnotes?|endnotes?|rearnotes?)\b/;
const PARAGRAPH_MARK = '\u001e';

const parseXml = (text) => new DOMParser().parseFromString(text, 'application/xml');

// Pfad aus dem OPF relativ zum OPF-Ordner auflösen ("../Text/Kapitel%201.xhtml")
function resolvePath(baseDir, href) {
    return decodeURIComponent(new URL(href, `https://epub.invalid/${baseDir}`).pathname.slice(1));
}

function htmlParagraphs(markup) {
    const parser = new DOMParser();
    let doc = parser.parseFromString(markup, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) doc = parser.parseFromString(markup, 'text/html');
    const body = doc.querySelector('body') || doc.documentElement;

    body.querySelectorAll('script, style, noscript, svg').forEach((el) => el.remove());
    // Fußnotenverweise und -texte würden den Lesefluss unterbrechen
    for (const el of body.querySelectorAll('*')) {
        const semantics = `${el.getAttribute('epub:type') || ''} ${el.getAttribute('role') || ''}`;
        if (NOTE_MARKUP.test(semantics) || (el.localName === 'sup' && el.querySelector('a'))) el.remove();
    }
    body.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
    for (const el of body.querySelectorAll(BLOCK_TAGS)) {
        el.before(PARAGRAPH_MARK);
        el.after(PARAGRAPH_MARK);
    }
    // textContent ohne Separator, damit Initialen wie <span>W</span>ort ein Wort bleiben
    return body.textContent.split(PARAGRAPH_MARK);
}

async function extractEpub(buffer, onProgress) {
    const zip = openZip(buffer);
    const container = await zip.text('META-INF/container.xml');
    const rootPath = container && parseXml(container).querySelector('rootfile')?.getAttribute('full-path');
    const opfText = rootPath && await zip.text(rootPath);
    if (!opfText) throw new ExtractionError('Keine gültige EPUB-Datei (Inhaltsverzeichnis fehlt).');

    const opf = parseXml(opfText);
    const baseDir = rootPath.slice(0, rootPath.lastIndexOf('/') + 1);
    const manifest = new Map();
    for (const item of opf.querySelectorAll('manifest > item')) {
        manifest.set(item.getAttribute('id'), {
            path: resolvePath(baseDir, item.getAttribute('href') || ''),
            type: item.getAttribute('media-type') || '',
            properties: item.getAttribute('properties') || '',
        });
    }

    // DRM: verschlüsselte Kapitel (nicht nur verschleierte Schriften) lassen sich nicht lesen
    const encryption = await zip.text('META-INF/encryption.xml');
    if (encryption) {
        const encrypted = new Set(
            [...parseXml(encryption).querySelectorAll('CipherReference')]
                .map((ref) => resolvePath('', ref.getAttribute('URI') || '')),
        );
        if ([...manifest.values()].some((item) => /html/.test(item.type) && encrypted.has(item.path))) {
            throw new ExtractionError('Dieses E-Book ist DRM-geschützt und kann nicht gelesen werden.');
        }
    }

    // Spine = Lesereihenfolge; Inhaltsverzeichnis und nichtlineare Anhänge überspringen
    const spine = [...opf.querySelectorAll('spine > itemref')]
        .filter((ref) => ref.getAttribute('linear') !== 'no')
        .map((ref) => manifest.get(ref.getAttribute('idref')))
        .filter((item) => item && /html/.test(item.type) && !/\bnav\b/.test(item.properties));

    const paragraphs = [];
    for (const [n, item] of spine.entries()) {
        onProgress?.(`Lese Kapitel ${n + 1} / ${spine.length} …`);
        const markup = await zip.text(item.path);
        if (markup) for (const paragraph of htmlParagraphs(markup)) paragraphs.push(paragraph);
    }
    const title = opf.getElementsByTagNameNS(DC_NS, 'title')[0]?.textContent.trim();
    return { title: title || null, paragraphs };
}

// --- Einstieg -------------------------------------------------------------------

async function fingerprint(buffer, file) {
    if (!crypto.subtle) return `${file.name}:${file.size}`; // nur ohne HTTPS (lokale Tests)
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
    return Array.from(hash.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

function detectFormat(buffer) {
    const head = new Uint8Array(buffer, 0, Math.min(5, buffer.byteLength));
    if (String.fromCharCode(...head) === '%PDF-') return 'pdf';
    if (head[0] === 0x50 && head[1] === 0x4b) return 'epub';
    return null;
}

export async function extractDocument(file, onProgress) {
    const buffer = await file.arrayBuffer();
    const format = detectFormat(buffer);
    if (!format) throw new ExtractionError('Nur EPUB- und PDF-Dateien werden unterstützt.');
    // Vor dem Parsen hashen: pdf.js übernimmt den Puffer in seinen Worker
    const id = await fingerprint(buffer, file);

    let result;
    try {
        result = format === 'pdf' ? await extractPdf(buffer, onProgress) : await extractEpub(buffer, onProgress);
    } catch (err) {
        if (err instanceof ExtractionError) throw err;
        throw new ExtractionError(`Datei konnte nicht gelesen werden: ${err.message}`);
    }

    const { words, paragraphEnds } = buildDocument(result.paragraphs);
    if (!words.length) {
        throw new ExtractionError('Kein lesbarer Text gefunden (gescanntes PDF oder DRM-geschütztes E-Book?).');
    }
    return {
        id,
        filename: result.title || file.name.replace(/\.[^.]+$/, ''),
        words,
        paragraphEnds,
    };
}
