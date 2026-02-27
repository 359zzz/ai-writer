from __future__ import annotations

import io
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ExtractedText:
    text: str
    meta: dict[str, Any]


class TextExtractError(RuntimeError):
    pass


_SUPPORTED_EXTS = {".txt", ".md", ".markdown", ".docx", ".pdf", ".epub"}


def _normalize_text(text: str) -> str:
    s = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    s = s.replace("\u00a0", " ")  # nbsp
    # Strip trailing whitespace and collapse excessive blank lines.
    lines = [ln.rstrip() for ln in s.split("\n")]
    out: list[str] = []
    blank = 0
    for ln in lines:
        if not ln.strip():
            blank += 1
            if blank <= 2:
                out.append("")
            continue
        blank = 0
        out.append(ln)
    return "\n".join(out).strip()


def _decode_text_bytes(data: bytes) -> str:
    for enc in ("utf-8", "utf-16", "utf-16-le", "utf-16-be", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
        except Exception:
            break
    return data.decode("utf-8", errors="ignore")


def _extract_docx(data: bytes) -> str:
    try:
        from docx import Document  # type: ignore
    except Exception as e:  # pragma: no cover
        raise TextExtractError(f"missing_dependency: python-docx ({type(e).__name__})") from e

    doc = Document(io.BytesIO(data))
    parts: list[str] = []
    for p in doc.paragraphs:
        if p.text:
            parts.append(p.text)
    return "\n".join(parts)


def _extract_pdf(data: bytes) -> str:
    try:
        from pypdf import PdfReader  # type: ignore
    except Exception as e:  # pragma: no cover
        raise TextExtractError(f"missing_dependency: pypdf ({type(e).__name__})") from e

    reader = PdfReader(io.BytesIO(data))

    page_texts: list[str] = []
    for page in reader.pages:
        try:
            t = page.extract_text() or ""
        except Exception:
            t = ""
        page_texts.append(t.replace("\r\n", "\n").replace("\r", "\n"))

    def is_page_number_line(line: str) -> bool:
        s = (line or "").strip()
        if not s:
            return False
        if re.fullmatch(r"\d{1,6}", s):
            return True
        if re.fullmatch(r"(?i)page\s+\d{1,6}", s):
            return True
        if re.fullmatch(r"[\-\u2013\u2014]?\s*\d{1,6}\s*[\-\u2013\u2014]?", s):
            return True
        return False

    # Heuristic: remove repeated header/footer lines across pages.
    header_counts: dict[str, int] = {}
    footer_counts: dict[str, int] = {}
    normalized_pages: list[list[str]] = []
    for t in page_texts:
        lines = [ln.strip() for ln in (t or "").split("\n")]
        lines = [ln for ln in lines if ln]
        normalized_pages.append(lines)
        if not lines:
            continue
        header = lines[0]
        footer = lines[-1]
        if header:
            header_counts[header] = header_counts.get(header, 0) + 1
        if footer:
            footer_counts[footer] = footer_counts.get(footer, 0) + 1

    n_pages = max(1, len(normalized_pages))
    min_hits = max(2, int(n_pages * 0.6))
    header_remove = {
        ln
        for ln, c in header_counts.items()
        if c >= min_hits and 3 <= len(ln) <= 100 and not is_page_number_line(ln)
    }
    footer_remove = {
        ln for ln, c in footer_counts.items() if c >= min_hits and 1 <= len(ln) <= 100
    }

    cleaned_pages: list[str] = []
    for lines in normalized_pages:
        if not lines:
            continue
        if lines and lines[0] in header_remove:
            lines = lines[1:]
        while lines and (lines[-1] in footer_remove or is_page_number_line(lines[-1])):
            lines = lines[:-1]
        cleaned_pages.append("\n".join(lines))

    return "\n\n".join(cleaned_pages)


def _extract_epub(data: bytes) -> str:
    try:
        from bs4 import BeautifulSoup  # type: ignore
    except Exception as e:  # pragma: no cover
        raise TextExtractError(f"missing_dependency: beautifulsoup4 ({type(e).__name__})") from e

    try:
        from ebooklib import epub  # type: ignore
    except Exception as e:  # pragma: no cover
        raise TextExtractError(f"missing_dependency: ebooklib ({type(e).__name__})") from e

    with tempfile.TemporaryDirectory(prefix="ai_writer_epub_") as td:
        path = Path(td) / "upload.epub"
        path.write_bytes(data)
        book = epub.read_epub(str(path))

    parts: list[str] = []
    for item in book.get_items():
        # ITEM_DOCUMENT is 9, but we avoid importing ITEM_DOCUMENT since some ebooklib versions differ.
        if getattr(item, "get_type", None) is None:
            continue
        if item.get_type() != 9:
            continue
        name = ""
        try:
            if getattr(item, "get_name", None) is not None:
                name = str(item.get_name() or "")
        except Exception:
            name = ""
        low = name.lower()
        # Skip common TOC/nav documents.
        if "toc" in low or "nav" in low:
            continue
        body = item.get_body_content()
        html = body.decode("utf-8", errors="ignore") if isinstance(body, (bytes, bytearray)) else str(body)
        soup = BeautifulSoup(html, "html.parser")
        # Get text with line breaks to preserve paragraph-ish structure.
        txt = soup.get_text("\n", strip=True)
        if txt:
            parts.append(txt)
    return "\n\n".join(parts)


def extract_text_from_bytes(
    *,
    filename: str,
    content_type: str | None,
    data: bytes,
) -> ExtractedText:
    """
    Extract plain text from supported file types for Continue Mode.

    Supported extensions:
    - .txt / .md / .markdown
    - .docx
    - .pdf
    - .epub
    """
    name = (filename or "").strip() or "upload"
    ext = Path(name).suffix.lower()
    if ext not in _SUPPORTED_EXTS:
        # Some browsers may send empty filename; try content-type fallback.
        ct = (content_type or "").lower()
        if ext == "" and ct == "text/plain":
            ext = ".txt"
        elif ext == "" and ct in {"application/pdf"}:
            ext = ".pdf"
        elif ext == "" and ct in {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        }:
            ext = ".docx"
        elif ext == "" and ct in {"application/epub+zip"}:
            ext = ".epub"

    if ext not in _SUPPORTED_EXTS:
        raise TextExtractError(f"unsupported_file_type: {ext or 'unknown'}")

    if ext in {".txt", ".md", ".markdown"}:
        raw = _decode_text_bytes(data)
        text = raw
    elif ext == ".docx":
        text = _extract_docx(data)
    elif ext == ".pdf":
        text = _extract_pdf(data)
    elif ext == ".epub":
        text = _extract_epub(data)
    else:  # pragma: no cover
        raise TextExtractError(f"unsupported_file_type: {ext}")

    text = _normalize_text(text)

    # A small heuristic cleanup for duplicated whitespace blocks from PDF extraction.
    text = re.sub(r"[ \t]{3,}", "  ", text)

    def _looks_like_toc_line(line: str) -> bool:
        s = (line or "").strip()
        if not s or len(s) > 200:
            return False
        # Dot-leader style TOC entries: "Chapter 1 ..... 12"
        if re.search(r"(\.{3,}|\u2026{3,}|\u00b7{3,}|\u3002{6,})", s) and re.search(
            r"\d{1,6}\s*$", s
        ):
            return True
        return False

    def _remove_toc_noise(text_in: str) -> str:
        lines = text_in.split("\n")
        scan = min(len(lines), 260)
        toc_like = 0
        for i in range(scan):
            if _looks_like_toc_line(lines[i]):
                toc_like += 1
        if toc_like < 12:
            return text_in
        out: list[str] = []
        for i, ln in enumerate(lines):
            s = ln.strip()
            if i < scan and (
                _looks_like_toc_line(ln)
                or s.lower() in {"contents", "table of contents", "\u76ee\u5f55"}
            ):
                continue
            out.append(ln)
        return "\n".join(out).strip()

    if ext in {".pdf", ".epub"}:
        text = _remove_toc_noise(text)

    return ExtractedText(
        text=text,
        meta={
            "filename": name,
            "ext": ext,
            "content_type": content_type or "",
            "bytes": len(data),
            "chars": len(text),
        },
    )
