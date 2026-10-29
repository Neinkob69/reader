// Fastreading – Textextraktion direkt im Browser: EPUB, PDF, DOCX, HTML, TXT → Absätze → Wort-Array.
// Alles läuft lokal auf dem Gerät, Bücher werden nirgendwohin hochgeladen.

const PDFJS_URL = new URL('./vendor/pdfjs/pdf.min.js', import.meta.url).href;
const PDFJS_WORKER_URL = new URL('./vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;

export class ExtractionError extends Error {}

// --- Text-Bereinigung & Tokenisierung ---------------------------------------

const LIGATURES = /[\uFB00-\uFB06]/g;
// Unsichtbare Zeichen (v. a. weiche Trennstriche in EPUBs) würden Wörter zerstückeln
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
const CONTROL_CHARS = /[\x00-\x08\x0E-\x1F\x7F-\x9F]/g;
const LINE_END_HYPHEN = /([\p{L}\p{N}])[-\u00AD\u2010][ \t]*\n\s*([\p{L}\p{N}])/gu;
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

// Flaches Wort-Array, letztes Wort jedes Absatzes (für Pausen) und erstes Wort jedes
// Absatzes (um Kapitelanfänge von Absatz- auf Wortposition umzurechnen)
export function buildDocument(paragraphs) {
    const words = [];
    const paragraphEnds = [];
    const paragraphStarts = [];
    for (const paragraph of paragraphs) {
        paragraphStarts.push(words.length);
        const tokens = tokenize(paragraph);
        if (!tokens.length) continue;
        for (const token of tokens) words.push(token);
        paragraphEnds.push(words.length - 1);
    }
    return { words, paragraphEnds, paragraphStarts };
}

const normalizeTitle = (text) => text.replace(/\s+/g, ' ').trim();

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
            blocks.push({ text: block.lines.join('\n'), size: block.size, top: block.top, flowEnd: gap <= 0 });
        }
        block = { lines: [text], last: ln, left: ln.x, size: ln.size, top: ln.y + ln.size, gap: null };
    }
    if (block) blocks.push({ text: block.lines.join('\n'), size: block.size, top: block.top, flowEnd: true });
    return blocks;
}

// Inhaltsverzeichnis-Seite: überwiegend Zeilen, die auf eine Seitenzahl enden ("Kapitel 3 ..... 41")
const TOC_LINE = /(?:\.{2,}|…|\s)\s*\d{1,4}$/;

function isTocPage(blocks) {
    const lines = blocks.flatMap((b) => b.text.split('\n')).map((l) => l.trim()).filter(Boolean);
    const hits = lines.filter((l) => TOC_LINE.test(l) && HAS_ALNUM.test(l.replace(/\d+$/, ''))).length;
    return hits >= 5 && hits / lines.length > 0.5;
}

const SMALL_TEXT = 0.88;
const LETTER_G = /\p{L}/gu;

function letterRatio(text) {
    const visible = text.replace(/\s/g, '').length;
    return visible ? (text.match(LETTER_G)?.length ?? 0) / visible : 0;
}

// Fließtext-Schriftgröße = die Größe, in der die meisten Zeichen stehen
function dominantSize(blocks) {
    const charsBySize = new Map();
    for (const block of blocks) {
        const key = Math.round(block.size * 2) / 2;
        charsBySize.set(key, (charsBySize.get(key) || 0) + block.text.length);
    }
    return [...charsBySize].reduce((best, entry) => (entry[1] > best[1] ? entry : best), [0, -1])[0];
}

// Überspringt Text, der zu Abbildungen gehört, statt zum Fließtext: Achsenbeschriftungen,
// Zahlenkolonnen, kleine Bildunterschriften und Fußnoten am Seitenende
function dropFigureText(pages) {
    const bodySize = dominantSize(pages.flat());

    return pages.map((blocks) => {
        const lastBody = blocks.findLastIndex((b) => b.size >= bodySize * SMALL_TEXT);
        const kept = [];
        blocks.forEach((block, i) => {
            const small = block.size < bodySize * SMALL_TEXT;
            const sparse = block.text.length < 40 && letterRatio(block.text) < 0.5;
            const footnote = small && lastBody >= 0 && i > lastBody;
            if (sparse || footnote || (small && block.text.length < 80)) {
                // Spaltenende-Markierung an den vorigen Block weitergeben
                if (block.flowEnd && kept.length) kept[kept.length - 1].flowEnd = true;
                return;
            }
            kept.push(block);
        });
        return kept;
    });
}

// Seitenzahlen in Kopf-/Fußzeilen unkenntlich machen, damit sie als gleich zählen
const edgeKey = (block) => block.text.toLowerCase().replace(/\d+/g, '#');

// Entfernt Seitenzahlen sowie Kopf- und Fußzeilen, die sich auf vielen Seiten wiederholen.
// Größer als der Fließtext sind Kopfzeilen nie, Kapitelüberschriften ("Kapitel 3" oben auf
// der Seite) dagegen schon, die bleiben deshalb stehen.
function stripRunningHeads(pages) {
    const maxSize = dominantSize(pages.flat()) * 1.1;
    const isRunningHead = (b) => b.text.length < 120 && b.size <= maxSize;
    const counts = new Map();
    for (const blocks of pages) {
        const edges = new Set(
            [...blocks.slice(0, EDGE_BLOCKS), ...blocks.slice(-EDGE_BLOCKS)]
                .filter(isRunningHead)
                .map(edgeKey),
        );
        for (const key of edges) counts.set(key, (counts.get(key) || 0) + 1);
    }
    const threshold = Math.max(3, pages.length * 0.25);

    return pages.map((blocks) => {
        const body = blocks.filter((block, i) => {
            const atEdge = i < EDGE_BLOCKS || i >= blocks.length - EDGE_BLOCKS;
            const isPageNumber = block.text.length < 15 && PAGE_NUMBER.test(block.text);
            const repeated = isRunningHead(block) && (counts.get(edgeKey(block)) || 0) >= threshold;
            return !(atEdge && (isPageNumber || repeated));
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
        // Ein Satz wechselt nicht mitten drin die Schriftgröße (Titelseite → Kapitelüberschrift)
        const sizeChange = Math.abs(current.size - block.size) > Math.max(current.size, block.size) * 0.15;
        if ((endsSentence || looksLikeHeading || sizeChange) && !isLower(block.text[0])) {
            paragraphs.push(current);
            current = { ...block };
        } else {
            // Satz läuft im nächsten Block weiter (Seiten-/Spaltenumbruch); Seite, Position
            // und Schriftgröße bleiben die des Absatzanfangs
            current = { ...current, text: `${current.text}\n${block.text}`, flowEnd: block.flowEnd };
        }
    }
    if (current) paragraphs.push(current);
    return paragraphs;
}

// Ziel eines PDF-Lesezeichens → Seitenindex und (falls angegeben) y-Position
async function resolveDestination(pdf, dest) {
    try {
        const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
        if (!Array.isArray(explicit)) return null;
        const [ref, mode, ...args] = explicit;
        const page = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref);
        const top = mode?.name === 'XYZ' ? args[1] : /^FitB?H$/.test(mode?.name) ? args[0] : null;
        return { page, top: typeof top === 'number' ? top : null };
    } catch {
        return null;
    }
}

async function pdfOutline(pdf) {
    const outline = await pdf.getOutline().catch(() => null);
    const entries = [];
    const walk = async (items, level) => {
        for (const item of items) {
            const target = await resolveDestination(pdf, item.dest);
            const title = normalizeTitle(item.title || '');
            if (target && title) entries.push({ title, level, ...target });
            if (item.items?.length) await walk(item.items, level + 1);
        }
    };
    if (outline) await walk(outline, 0);
    return entries;
}

const titleKey = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// Lesezeichen auf Absätze abbilden: bevorzugt die Überschrift mit passendem Text auf der
// Zielseite, sonst der Absatz an der angegebenen Höhe, sonst der erste Absatz der Seite
function mapOutline(entries, paragraphs) {
    const byPage = new Map();
    paragraphs.forEach((p, i) => {
        if (!byPage.has(p.page)) byPage.set(p.page, []);
        byPage.get(p.page).push(i);
    });
    const chapters = [];
    for (const entry of entries) {
        const key = titleKey(entry.title);
        const onPage = byPage.get(entry.page) || [];
        const nearby = [...onPage, ...(byPage.get(entry.page + 1) || [])];
        let para = nearby.find((i) => {
            const text = titleKey(paragraphs[i].text);
            return key && (text.startsWith(key.slice(0, 30)) || (text.length >= 4 && key.startsWith(text)));
        });
        if (para === undefined && entry.top !== null && onPage.length) {
            para = onPage.reduce((best, i) => (
                Math.abs(paragraphs[i].top - entry.top) < Math.abs(paragraphs[best].top - entry.top) ? i : best
            ));
        }
        if (para === undefined) {
            const next = paragraphs.findIndex((p) => p.page >= entry.page);
            if (next >= 0) para = next;
        }
        if (para !== undefined) chapters.push({ title: entry.title, level: entry.level, para });
    }
    return chapters;
}

// Ohne Lesezeichen: Überschriften an der größeren Schrift erkennen
function headingChapters(paragraphs) {
    const bodySize = dominantSize(paragraphs);
    const headings = paragraphs
        .map((p, para) => ({ p, para }))
        .filter(({ p }) => p.size >= bodySize * 1.15 && p.text.length <= 120 && letterRatio(p.text) > 0.5);
    const sizes = [...new Set(headings.map(({ p }) => Math.round(p.size)))].sort((a, b) => b - a);
    return headings.map(({ p, para }) => ({
        title: normalizeTitle(p.text),
        level: Math.min(2, sizes.indexOf(Math.round(p.size))),
        para,
    }));
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
        const tocPages = new Set();
        for (let n = 1; n <= pdf.numPages; n++) {
            onProgress?.(`Lese Seite ${n} / ${pdf.numPages} …`);
            const page = await pdf.getPage(n);
            const blocks = pageBlocks((await page.getTextContent()).items);
            page.cleanup();
            blocks.forEach((block) => { block.page = n - 1; });
            // Inhaltsverzeichnis-Seiten nicht vorlesen, dafür gibt es die Kapitelansicht
            if (isTocPage(blocks)) tocPages.add(n - 1);
            pages.push(tocPages.has(n - 1) ? [] : blocks);
        }
        const paragraphs = mergePdfBlocks(dropFigureText(stripRunningHeads(pages)));
        const outline = (await pdfOutline(pdf)).filter((entry) => !tocPages.has(entry.page));
        const chapters = outline.length ? mapOutline(outline, paragraphs) : headingChapters(paragraphs);
        return { title: null, paragraphs: paragraphs.map((p) => p.text), chapters };
    } finally {
        task.destroy();
    }
}

// --- ZIP (EPUB & DOCX) -----------------------------------------------------------

// Text dekodieren: UTF-16 per BOM, sonst UTF-8 mit Fallback auf Windows-1252 (alte TXT-Dateien)
function decodeText(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return new TextDecoder('windows-1252').decode(bytes);
    }
}

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
    if (eocd < 0) throw new ExtractionError('Die Datei ist beschädigt (ZIP-Struktur fehlt).');

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
        if (entry.method !== 8) throw new ExtractionError('Nicht unterstützte ZIP-Kompression.');
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    return {
        has: (name) => entries.has(name),
        async text(name) {
            const data = await read(name);
            return data && decodeText(data);
        },
    };
}

// --- HTML (EPUB-Kapitel & gespeicherte Webseiten) ------------------------------------

const BLOCK_TAGS = [
    'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt',
    'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
    'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul',
].join(',');
// Alles ohne lesbaren Fließtext: Medien samt Fallback-Texten, Animationen, interaktive
// Elemente, versteckte Inhalte und Bildunterschriften
const SKIPPED_ELEMENTS = [
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'video', 'audio',
    'object', 'embed', 'iframe', 'button', 'select', 'textarea', 'figcaption',
    '[hidden]', '[aria-hidden="true"]',
].join(',');
const NOTE_MARKUP = /\b(?:doc-)?(?:noteref|footnotes?|endnotes?|rearnotes?)\b/;
const PARAGRAPH_MARK = '\u001e';

const parseXml = (text) => new DOMParser().parseFromString(text, 'application/xml');

function elementParagraphs(root) {
    root.querySelectorAll(SKIPPED_ELEMENTS).forEach((el) => el.remove());
    // Fußnotenverweise und -texte würden den Lesefluss unterbrechen
    for (const el of root.querySelectorAll('*')) {
        const semantics = `${el.getAttribute('epub:type') || ''} ${el.getAttribute('role') || ''}`;
        if (NOTE_MARKUP.test(semantics) || (el.localName === 'sup' && el.querySelector('a'))) el.remove();
    }
    root.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
    for (const el of root.querySelectorAll(BLOCK_TAGS)) {
        el.before(PARAGRAPH_MARK);
        el.after(PARAGRAPH_MARK);
    }
    // textContent ohne Separator, damit Initialen wie <span>W</span>ort ein Wort bleiben
    return root.textContent.split(PARAGRAPH_MARK);
}

function parseHtml(markup) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(markup, 'application/xhtml+xml');
    return doc.getElementsByTagName('parsererror').length ? parser.parseFromString(markup, 'text/html') : doc;
}

// Kapitelanfänge: Vor dem Zielelement wird ein eigener "Anker-Absatz" eingefügt. Beim
// Einsammeln der Absätze wird er entfernt und seine Position gemerkt.
const ANCHOR = String.fromCharCode(0x1f);
const ANCHOR_PARAGRAPH = new RegExp(`^\\s*${ANCHOR}(\\d+)\\s*$`);

function insertAnchor(el, id) {
    el.before(`${PARAGRAPH_MARK}${ANCHOR}${id}${PARAGRAPH_MARK}`);
}

function appendParagraphs(target, raw, anchorParas) {
    for (const text of raw) {
        const anchor = text.match(ANCHOR_PARAGRAPH);
        if (anchor) anchorParas.set(Number(anchor[1]), target.length);
        else target.push(text);
    }
}

// Überschriften als Kapitel, wenn es kein offizielles Inhaltsverzeichnis gibt;
// Anker-ID = idOffset + Position in chapters
function anchorHeadings(root, chapters, idOffset = 0) {
    for (const heading of root.querySelectorAll('h1, h2, h3')) {
        const title = normalizeTitle(heading.textContent);
        if (!title) continue;
        insertAnchor(heading, idOffset + chapters.length);
        chapters.push({ title, level: Number(heading.localName[1]) - 1 });
    }
}

function extractHtml(markup) {
    const doc = parseHtml(markup);
    // Gespeicherte Webseite: möglichst nur den Artikel, ohne Navigation und Seitenleisten
    let root = doc.querySelector('article') || doc.querySelector('main');
    if (!root) {
        root = doc.querySelector('body') || doc.documentElement;
        root.querySelectorAll('nav, header, footer, aside, form').forEach((el) => el.remove());
    }
    root.querySelectorAll('nav, aside').forEach((el) => el.remove());

    const chapters = [];
    anchorHeadings(root, chapters);
    const paragraphs = [];
    const anchorParas = new Map();
    appendParagraphs(paragraphs, elementParagraphs(root), anchorParas);
    return {
        title: doc.querySelector('title')?.textContent.trim() || null,
        paragraphs,
        chapters: chapters.map((chapter, id) => ({ ...chapter, para: anchorParas.get(id) })),
    };
}

// --- EPUB -----------------------------------------------------------------------

const DC_NS = 'http://purl.org/dc/elements/1.1/';

const dirOf = (path) => path.slice(0, path.lastIndexOf('/') + 1);

function safeDecode(text) {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

// Verweis relativ zu einem Ordner auflösen ("../Text/Kapitel%201.xhtml#abschnitt")
function resolveHref(baseDir, href) {
    const url = new URL(href, `https://epub.invalid/${baseDir}`);
    return { path: safeDecode(url.pathname.slice(1)), fragment: safeDecode(url.hash.slice(1)) };
}

const resolvePath = (baseDir, href) => resolveHref(baseDir, href).path;
const hasType = (el, type) => new RegExp(`\\b${type}\\b`).test(el.getAttribute('epub:type') || '');

// EPUB 3: Inhaltsverzeichnis und Landmarken (wo steht das Verzeichnis, wo beginnt der Text)
function readNav(doc, dir) {
    const navs = [...doc.querySelectorAll('nav')];
    const toc = [];
    const walk = (list, level) => {
        for (const li of list.children) {
            if (li.localName !== 'li') continue;
            const link = li.querySelector(':scope > a[href]');
            const title = normalizeTitle(link?.textContent || '');
            if (link && title) toc.push({ title, level, ...resolveHref(dir, link.getAttribute('href')) });
            const sub = li.querySelector(':scope > ol, :scope > ul');
            if (sub) walk(sub, level + 1);
        }
    };
    const list = (navs.find((nav) => hasType(nav, 'toc')) || navs[0])?.querySelector('ol, ul');
    if (list) walk(list, 0);

    const tocPages = new Set();
    let start = null;
    const landmarks = navs.find((nav) => hasType(nav, 'landmarks'));
    for (const link of landmarks?.querySelectorAll('a[href]') || []) {
        const target = resolveHref(dir, link.getAttribute('href'));
        if (hasType(link, 'toc')) tocPages.add(target.path);
        if (hasType(link, 'bodymatter')) start = target;
    }
    return { toc, tocPages, start };
}

// EPUB 2: Inhaltsverzeichnis aus der NCX-Datei
function readNcx(doc, dir) {
    const toc = [];
    const walk = (parent, level) => {
        for (const point of parent.children) {
            if (point.localName !== 'navPoint') continue;
            const title = normalizeTitle(point.querySelector(':scope > navLabel > text')?.textContent || '');
            const src = point.querySelector(':scope > content')?.getAttribute('src');
            if (title && src) toc.push({ title, level, ...resolveHref(dir, src) });
            walk(point, level + 1);
        }
    };
    const map = doc.querySelector('navMap');
    if (map) walk(map, 0);
    return toc;
}

// Nicht markierte Inhaltsverzeichnisse und Register: Seiten, die fast nur aus Links bestehen
function isLinkList(root) {
    const links = root.querySelectorAll('a[href]');
    const total = root.textContent.replace(/\s/g, '').length;
    if (links.length < 5 || !total) return false;
    const linked = [...links].reduce((sum, a) => sum + a.textContent.replace(/\s/g, '').length, 0);
    return linked / total > 0.6;
}

function findById(doc, id) {
    return doc.getElementById(id)
        || [...doc.querySelectorAll('[id], [name]')].find((el) => el.getAttribute('id') === id || el.getAttribute('name') === id);
}

async function extractEpub(zip, onProgress) {
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

    // Offizielles Inhaltsverzeichnis: EPUB 3 (nav), sonst EPUB 2 (NCX)
    const items = [...manifest.values()];
    const navItem = items.find((item) => /\bnav\b/.test(item.properties));
    const ncxItem = manifest.get(opf.querySelector('spine')?.getAttribute('toc'))
        || items.find((item) => item.type === 'application/x-dtbncx+xml');
    let { toc, tocPages, start } = { toc: [], tocPages: new Set(), start: null };
    const navMarkup = navItem && await zip.text(navItem.path);
    if (navMarkup) ({ toc, tocPages, start } = readNav(parseHtml(navMarkup), dirOf(navItem.path)));
    const ncxMarkup = !toc.length && ncxItem && await zip.text(ncxItem.path);
    if (ncxMarkup) toc = readNcx(parseXml(ncxMarkup), dirOf(ncxItem.path));
    // EPUB 2: <guide> nennt ebenfalls Verzeichnis und Textbeginn
    for (const ref of opf.querySelectorAll('guide > reference[href]')) {
        const target = resolveHref(baseDir, ref.getAttribute('href'));
        const type = (ref.getAttribute('type') || '').toLowerCase();
        if (type === 'toc') tocPages.add(target.path);
        if (!start && (type === 'text' || type === 'start' || type === 'bodymatter')) start = target;
    }

    // Sprungziele je Datei: Kapitel 0 … n-1, danach der Textbeginn
    const targets = new Map();
    const addTarget = ({ path, fragment }, id) => {
        if (!targets.has(path)) targets.set(path, []);
        targets.get(path).push({ fragment, id });
    };
    toc.forEach((entry, id) => addTarget(entry, id));
    const startId = toc.length;
    if (start) addTarget(start, startId);
    const headings = []; // nur ohne Inhaltsverzeichnis: Überschriften als Kapitel
    const headingOffset = startId + 1;

    // Spine = Lesereihenfolge; Inhaltsverzeichnisse und nichtlineare Anhänge überspringen
    const spine = [...opf.querySelectorAll('spine > itemref')]
        .filter((ref) => ref.getAttribute('linear') !== 'no')
        .map((ref) => manifest.get(ref.getAttribute('idref')))
        .filter((item) => item && /html/.test(item.type) && !/\bnav\b/.test(item.properties) && !tocPages.has(item.path));

    const paragraphs = [];
    const anchorParas = new Map();
    for (const [n, item] of spine.entries()) {
        onProgress?.(`Lese Kapitel ${n + 1} / ${spine.length} …`);
        const markup = await zip.text(item.path);
        if (!markup) continue;
        const doc = parseHtml(markup);
        const body = doc.querySelector('body') || doc.documentElement;
        if (isLinkList(body)) continue;
        for (const { fragment, id } of targets.get(item.path) || []) {
            const el = fragment && findById(doc, fragment);
            if (el && el !== body && body.contains(el)) insertAnchor(el, id);
            else anchorParas.set(id, paragraphs.length); // Ziel = Dateianfang
        }
        if (!toc.length) anchorHeadings(body, headings, headingOffset);
        appendParagraphs(paragraphs, elementParagraphs(body), anchorParas);
    }

    const chapters = toc.length
        ? toc.map((entry, id) => ({ title: entry.title, level: entry.level, para: anchorParas.get(id) }))
        : headings.map((heading, k) => ({ title: heading.title, level: heading.level, para: anchorParas.get(headingOffset + k) }));
    const title = opf.getElementsByTagNameNS(DC_NS, 'title')[0]?.textContent.trim();
    return { title: title || null, paragraphs, chapters, start: anchorParas.get(startId) };
}

// --- Word (DOCX) -------------------------------------------------------------------

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

// Nächster Absatz (w:p) über einem Knoten; null für Ersatzinhalte (mc:Fallback = Duplikat)
function owningParagraph(node) {
    for (let el = node.parentElement; el; el = el.parentElement) {
        if (el.localName === 'Fallback') return null;
        if (el.localName === 'p' && el.namespaceURI === W_NS) return el;
    }
    return null;
}

// Formatvorlagen-IDs: "Heading1" (englisches Word), "berschrift1" (deutsches Word), "Title"
const HEADING_STYLE = /^(?:heading|.*berschrift)\s*([1-3])$/i;

function headingLevel(p) {
    const pPr = [...p.children].find((child) => child.localName === 'pPr');
    const style = [...(pPr?.children || [])].find((child) => child.localName === 'pStyle')?.getAttributeNS(W_NS, 'val') || '';
    if (/^title$/i.test(style)) return 0;
    const match = style.match(HEADING_STYLE);
    return match ? Number(match[1]) - 1 : null;
}

async function extractDocx(zip) {
    const xml = parseXml(await zip.text('word/document.xml'));
    const paragraphs = [];
    const chapters = [];
    for (const p of xml.getElementsByTagNameNS(W_NS, 'p')) {
        let text = '';
        for (const node of p.getElementsByTagNameNS(W_NS, '*')) {
            if (owningParagraph(node) !== p) continue; // Textfelder bekommen eigene Absätze
            if (node.localName === 't') text += node.textContent;
            else if (node.localName === 'tab' || node.localName === 'br' || node.localName === 'cr') text += ' ';
            else if (node.localName === 'noBreakHyphen') text += '-';
        }
        const level = headingLevel(p);
        if (level !== null && text.trim()) chapters.push({ title: normalizeTitle(text), level, para: paragraphs.length });
        paragraphs.push(text);
    }
    return { title: null, paragraphs, chapters };
}

// --- Reiner Text ---------------------------------------------------------------------

const GUTENBERG_START = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*\n/i;
const GUTENBERG_END = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG/i;

function textParagraphs(text) {
    // Lizenztexte von Project Gutenberg vor und nach dem eigentlichen Buch weglassen
    const start = text.match(GUTENBERG_START);
    if (start) text = text.slice(start.index + start[0].length);
    const end = text.search(GUTENBERG_END);
    if (end >= 0) text = text.slice(0, end);

    text = text.replace(/\r\n?/g, '\n');
    // Absätze durch Leerzeilen getrennt (Bücher mit festem Zeilenumbruch) oder eine Zeile pro Absatz
    return /\n[ \t]*\n/.test(text) ? text.split(/\n[ \t]*\n/) : text.split('\n');
}

// Kapitelzeilen in reinem Text: "Kapitel 3", "CHAPTER IV", "Prolog" oder nur "XII"
const TEXT_CHAPTER = /^(?:(?:kapitel|chapter|teil|part|buch|book|akt|act)\s+(?:\d+|[IVXLC]+)\b.*|prolog|prologue|epilog|epilogue|vorwort|nachwort|einleitung|introduction)$/i;
const ROMAN_NUMERAL = /^[IVXLC]+\.?$/;

function textChapters(paragraphs) {
    const chapters = [];
    paragraphs.forEach((text, para) => {
        const title = normalizeTitle(text);
        if (title.length <= 70 && (TEXT_CHAPTER.test(title) || ROMAN_NUMERAL.test(title))) {
            chapters.push({ title, level: 0, para });
        }
    });
    return chapters;
}

// --- Einstieg -------------------------------------------------------------------

async function fingerprint(buffer, fallback) {
    if (!crypto.subtle) return fallback; // nur ohne HTTPS (lokale Tests)
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
    return Array.from(hash.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

const ascii = (bytes, start, end) => String.fromCharCode(...bytes.subarray(start, end));

async function extract(buffer, name, onProgress) {
    const bytes = new Uint8Array(buffer);
    if (ascii(bytes, 0, 5) === '%PDF-') return extractPdf(buffer, onProgress);
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
        const zip = openZip(buffer);
        if (zip.has('META-INF/container.xml')) return extractEpub(zip, onProgress);
        if (zip.has('word/document.xml')) return extractDocx(zip);
        throw new ExtractionError('Diese ZIP-Datei ist weder ein EPUB noch ein Word-Dokument.');
    }
    if (['BOOKMOBI', 'TEXtREAd'].includes(ascii(bytes, 60, 68))) {
        throw new ExtractionError('Kindle-Formate (MOBI/AZW) werden nicht unterstützt – lade das Buch als EPUB herunter.');
    }
    if (ascii(bytes, 0, 8) === 'AT&TFORM') {
        throw new ExtractionError('DjVu-Dateien sind eingescannte Seiten und enthalten keinen lesbaren Text.');
    }

    if (/\.(?:epub|pdf|docx)$/i.test(name)) {
        throw new ExtractionError('Die Datei ist beschädigt oder hat die falsche Endung.');
    }
    const hasBom = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
    if (!hasBom && bytes.subarray(0, 4096).includes(0)) {
        throw new ExtractionError('Dateiformat nicht unterstützt. Möglich sind EPUB, PDF, DOCX, TXT und HTML.');
    }
    const text = decodeText(bytes);
    if (/\.x?html?$/i.test(name) || /^\s*<(?:!doctype html|html|\?xml)/i.test(text)) return extractHtml(text);
    const paragraphs = textParagraphs(text);
    return { title: null, paragraphs, chapters: textChapters(paragraphs) };
}

// Absätze → Wörter; Kapitel und Textbeginn von Absatz- auf Wortpositionen umrechnen
function finish(id, title, result) {
    const { words, paragraphEnds, paragraphStarts } = buildDocument(result.paragraphs);
    if (!words.length) {
        throw new ExtractionError('Kein lesbarer Text gefunden (gescanntes PDF oder DRM-geschütztes E-Book?).');
    }
    const toWord = (para) => (para === undefined || para === null || para >= paragraphStarts.length
        ? null
        : Math.min(paragraphStarts[para], words.length - 1));
    const chapters = (result.chapters || [])
        .map((chapter) => ({ title: chapter.title, level: chapter.level || 0, index: toWord(chapter.para) }))
        .filter((chapter) => chapter.title && chapter.index !== null);
    return {
        id,
        filename: title || words.slice(0, 5).join(' ') + (words.length > 5 ? ' …' : ''),
        words,
        paragraphEnds,
        chapters,
        start: toWord(result.start) ?? 0,
    };
}

export async function extractDocument(file, onProgress) {
    const buffer = await file.arrayBuffer();
    // Vor dem Parsen hashen: pdf.js übernimmt den Puffer in seinen Worker
    const id = await fingerprint(buffer, `${file.name}:${file.size}`);
    let result;
    try {
        result = await extract(buffer, file.name, onProgress);
    } catch (err) {
        if (err instanceof ExtractionError) throw err;
        throw new ExtractionError(`Datei konnte nicht gelesen werden: ${err.message}`);
    }
    return finish(id, result.title || file.name.replace(/\.[^.]+$/, ''), result);
}

// Eingefügter Text (z. B. ein Artikel aus der Zwischenablage); Titel = die ersten Wörter
export async function documentFromText(text) {
    const id = await fingerprint(new TextEncoder().encode(text).buffer, `text:${text.length}`);
    const paragraphs = textParagraphs(text);
    return finish(id, null, { paragraphs, chapters: textChapters(paragraphs) });
}
