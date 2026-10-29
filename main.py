"""Argon RSVP – Backend.

Nimmt EPUB- und PDF-Dateien entgegen, extrahiert den reinen Text und liefert ihn
als flaches Wort-Array (plus Absatzgrenzen für längere Pausen) an das Frontend.
"""

import hashlib
import io
import re
import socket
import unicodedata
import warnings
from collections import Counter
from pathlib import Path

import ebooklib
import pymupdf
from bs4 import BeautifulSoup
from ebooklib import epub
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
MAX_UPLOAD_BYTES = 200 * 1024 * 1024

app = FastAPI(title="Argon RSVP")


class ExtractionError(Exception):
    """Die Datei ist kaputt, verschlüsselt oder enthält keinen lesbaren Text."""


# --- Text-Bereinigung & Tokenisierung ---------------------------------------

# Ligaturen (ﬁ, ﬂ, …) aus PDFs/EPUBs in normale Buchstaben auflösen
LIGATURES = {cp: unicodedata.normalize("NFKC", chr(cp)) for cp in range(0xFB00, 0xFB07)}
# Unsichtbare Zeichen (v. a. weiche Trennstriche in EPUBs) würden Wörter zerstückeln
INVISIBLE = dict.fromkeys(map(ord, "­​‌‍⁠﻿"), None)
CONTROL_CHARS = re.compile(r"[\x00-\x08\x0e-\x1f\x7f-\x9f]")
LINE_END_HYPHEN = re.compile(r"(\w)[-­‐][ \t]*\n\s*(\w)")
DASH_BREAK = re.compile(r"(?<=[–—])(?=\w)")
HYPHEN_BREAK = re.compile(r"(?<=\w-)(?=\w)")
HAS_ALNUM = re.compile(r"[^\W_]")
LONG_COMPOUND = 24


def _join_hyphenated(match: re.Match) -> str:
    # "Wissen-\nschaft" -> "Wissenschaft", aber "Ost-\nWest" -> "Ost-West"
    head, tail = match.group(1), match.group(2)
    return head + tail if tail.islower() else f"{head}-{tail}"


def clean_text(raw: str) -> str:
    text = unicodedata.normalize("NFC", raw).translate(LIGATURES)
    text = LINE_END_HYPHEN.sub(_join_hyphenated, text)
    text = text.translate(INVISIBLE)
    return CONTROL_CHARS.sub("", text)


def tokenize(paragraph: str) -> list[str]:
    """Zerlegt einen Absatz in Wörter. Satzzeichen bleiben für das Pacing erhalten."""
    words: list[str] = []
    for token in clean_text(paragraph).split():
        for part in DASH_BREAK.split(token):
            # Sehr lange Bindestrich-Komposita am Bindestrich aufteilen
            if len(part) > LONG_COMPOUND and "-" in part:
                parts = [p for p in HYPHEN_BREAK.split(part) if p]
            else:
                parts = [part]
            for piece in parts:
                # Alleinstehende Satzzeichen ("–", "…") ans vorige Wort hängen
                if words and not HAS_ALNUM.search(piece):
                    words[-1] = f"{words[-1]} {piece}"
                else:
                    words.append(piece)
    return words


def build_document(paragraphs: list[str]) -> tuple[list[str], list[int]]:
    """Flaches Wort-Array plus Index des jeweils letzten Worts eines Absatzes."""
    words: list[str] = []
    paragraph_ends: list[int] = []
    for paragraph in paragraphs:
        tokens = tokenize(paragraph)
        if tokens:
            words.extend(tokens)
            paragraph_ends.append(len(words) - 1)
    return words, paragraph_ends


# --- PDF ----------------------------------------------------------------------

PDF_FLAGS = pymupdf.TEXTFLAGS_TEXT & ~pymupdf.TEXT_PRESERVE_LIGATURES
PAGE_NUMBER = re.compile(r"[\W\d_]*\d[\W\d_]*")
SENTENCE_END = re.compile(r"[.!?:…\"'»«“”’)\]]$")
EDGE_BLOCKS = 2


def _edge_key(block: str) -> str:
    # Seitenzahlen in Kopf-/Fußzeilen unkenntlich machen, damit sie als gleich zählen
    return re.sub(r"\d+", "#", block.lower())


def strip_running_heads(pages: list[list[str]]) -> list[list[str]]:
    """Entfernt Seitenzahlen sowie Kopf- und Fußzeilen, die sich auf vielen Seiten wiederholen."""
    counts: Counter[str] = Counter()
    for blocks in pages:
        edges = blocks[:EDGE_BLOCKS] + blocks[-EDGE_BLOCKS:]
        counts.update({_edge_key(b) for b in edges if len(b) < 120})
    threshold = max(3, len(pages) * 0.25)
    repeated = {key for key, n in counts.items() if n >= threshold}

    cleaned = []
    for blocks in pages:
        keep = []
        for i, block in enumerate(blocks):
            at_edge = i < EDGE_BLOCKS or i >= len(blocks) - EDGE_BLOCKS
            is_page_number = len(block) < 15 and PAGE_NUMBER.fullmatch(block)
            if at_edge and (is_page_number or _edge_key(block) in repeated):
                continue
            keep.append(block)
        cleaned.append(keep)
    return cleaned


def merge_pdf_blocks(pages: list[list[str]]) -> list[str]:
    """Setzt Textblöcke zu Absätzen zusammen, auch über Spalten- und Seitenumbrüche hinweg."""
    paragraphs: list[str] = []
    current = ""
    for block in (b for blocks in pages for b in blocks):
        if not current:
            current = block
            continue
        starts_lower = block[0].islower()
        ends_sentence = bool(SENTENCE_END.search(current))
        looks_like_heading = len(current) < 80 and not ends_sentence
        if (ends_sentence or looks_like_heading) and not starts_lower:
            paragraphs.append(current)
            current = block
        else:
            # Satz läuft im nächsten Block weiter (Seiten-/Spaltenumbruch)
            current = f"{current}\n{block}"
    if current:
        paragraphs.append(current)
    return paragraphs


def extract_from_pdf(data: bytes) -> list[str]:
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        if doc.needs_pass:
            raise ExtractionError("Das PDF ist passwortgeschützt.")
        pages = []
        for page in doc:
            blocks = page.get_text("blocks", flags=PDF_FLAGS)
            pages.append([b[4].strip() for b in blocks if b[6] == 0 and b[4].strip()])
    return merge_pdf_blocks(strip_running_heads(pages))


# --- EPUB -----------------------------------------------------------------------

BLOCK_TAGS = [
    "address", "article", "aside", "blockquote", "dd", "div", "dl", "dt",
    "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
    "header", "hr", "li", "ol", "p", "pre", "section", "table", "td", "th",
    "tr", "ul",
]
NOTE_MARKUP = re.compile(r"\b(?:doc-)?(?:noteref|footnotes?|endnotes?|rearnotes?)\b")
PARAGRAPH_MARK = "\x1e"


def html_paragraphs(markup: bytes) -> list[str]:
    soup = BeautifulSoup(markup, "html.parser")
    body = soup.body or soup
    for tag in body.find_all(["script", "style", "noscript", "svg"]):
        tag.decompose()
    # Fußnotenverweise und -texte würden den Lesefluss unterbrechen
    for attr in ("epub:type", "role"):
        for tag in body.find_all(attrs={attr: NOTE_MARKUP}):
            if not tag.decomposed:
                tag.decompose()
    for sup in body.find_all("sup"):
        if not sup.decomposed and sup.find("a"):
            sup.decompose()
    for br in body.find_all("br"):
        br.replace_with(" ")
    for tag in body.find_all(BLOCK_TAGS):
        tag.insert_before(PARAGRAPH_MARK)
        tag.insert_after(PARAGRAPH_MARK)
    # Ohne Separator, damit Initialen wie <span>W</span>ort ein Wort bleiben
    return body.get_text().split(PARAGRAPH_MARK)


def extract_from_epub(data: bytes) -> list[str]:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        book = epub.read_epub(io.BytesIO(data), {"ignore_ncx": True})

    paragraphs: list[str] = []
    # Spine = Lesereihenfolge (die Manifest-Reihenfolge ist oft durcheinander)
    for idref, linear in book.spine:
        item = book.get_item_with_id(idref)
        if (
            item is None
            or linear == "no"
            or isinstance(item, epub.EpubNav)
            or item.get_type() != ebooklib.ITEM_DOCUMENT
        ):
            continue
        paragraphs.extend(html_paragraphs(item.get_content()))
    return paragraphs


EXTRACTORS = {".pdf": extract_from_pdf, ".epub": extract_from_epub}


# --- API ------------------------------------------------------------------------

@app.post("/api/upload")
def upload_document(file: UploadFile = File(...)):
    filename = file.filename or "Dokument"
    extractor = EXTRACTORS.get(Path(filename).suffix.lower())
    if extractor is None:
        raise HTTPException(415, "Nur .epub- und .pdf-Dateien werden unterstützt.")

    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Datei ist zu groß (max. 200 MB).")

    try:
        paragraphs = extractor(data)
    except ExtractionError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(422, f"Datei konnte nicht gelesen werden: {exc}") from exc

    words, paragraph_ends = build_document(paragraphs)
    if not words:
        raise HTTPException(
            422, "Kein lesbarer Text gefunden (gescanntes PDF oder DRM-geschütztes E-Book?)."
        )

    return {
        "doc_id": hashlib.sha256(data).hexdigest()[:16],
        "filename": filename,
        "total_words": len(words),
        "words": words,
        "paragraph_ends": paragraph_ends,
    }


@app.get("/", include_in_schema=False)
def serve_frontend():
    # no-cache, damit die Home-Bildschirm-App Updates sofort mitbekommt
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def lan_ip() -> str:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))  # sendet nichts, ermittelt nur die Route
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


if __name__ == "__main__":
    import uvicorn

    print(f"\n  Argon läuft – auf dem iPhone (gleiches WLAN) öffnen: http://{lan_ip()}:8000\n")
    uvicorn.run(app, host="0.0.0.0", port=8000)
