from __future__ import annotations

import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from markdown import markdown as md_to_html
from sqlmodel import select

from ..db import get_session
from ..models import Chapter, Project


router = APIRouter(prefix="/api/projects/{project_id}/export", tags=["export"])

ExportFormat = Literal["docx", "epub", "pdf"]


def _now_tag() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def _exports_dir() -> Path:
    api_root = Path(__file__).resolve().parents[2]  # .../apps/api
    out = api_root / "exports"
    out.mkdir(parents=True, exist_ok=True)
    return out


def _compile_markdown(project: Project, chapters: list[Chapter]) -> str:
    parts: list[str] = [f"# {project.title}", ""]
    for ch in chapters:
        parts.append(f"\n\n# {ch.chapter_index}. {ch.title}".strip())
        parts.append("")
        parts.append(ch.markdown.strip())
        parts.append("")
    return "\n".join(parts).strip() + "\n"


def _strip_markdown(md: str) -> str:
    # Very light markdown stripping (good enough for basic PDF fallback).
    t = re.sub(r"`{1,3}.*?`{1,3}", "", md, flags=re.S)
    t = re.sub(r"^#+\\s*", "", t, flags=re.M)
    t = re.sub(r"\\*\\*([^*]+)\\*\\*", r"\\1", t)
    t = re.sub(r"\\*([^*]+)\\*", r"\\1", t)
    t = re.sub(r"\\[(.*?)\\]\\((.*?)\\)", r"\\1 (\\2)", t)
    return t


def _pandoc_available() -> bool:
    return shutil.which("pandoc") is not None


def _export_with_pandoc(md_path: Path, out_path: Path) -> None:
    cmd = ["pandoc", str(md_path), "-o", str(out_path)]
    subprocess.run(cmd, check=True, capture_output=True)


def _export_docx_basic(md_text: str, out_path: Path) -> None:
    from docx import Document

    doc = Document()
    for line in md_text.splitlines():
        t = line.rstrip()
        if not t:
            doc.add_paragraph("")
            continue
        if t.startswith("# "):
            doc.add_heading(t[2:].strip(), level=1)
            continue
        if t.startswith("## "):
            doc.add_heading(t[3:].strip(), level=2)
            continue
        doc.add_paragraph(_strip_markdown(t))
    doc.save(out_path)


def _export_epub_basic(project: Project, md_text: str, out_path: Path) -> None:
    from ebooklib import epub

    book = epub.EpubBook()
    book.set_identifier(project.id)
    book.set_title(project.title)
    book.set_language("zh")

    html = md_to_html(md_text, extensions=["fenced_code", "tables"])
    chapter = epub.EpubHtml(title=project.title, file_name="chap_001.xhtml", lang="zh")
    chapter.content = html
    book.add_item(chapter)

    book.toc = (chapter,)
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    style = "body { font-family: serif; line-height: 1.6; }"
    nav_css = epub.EpubItem(uid="style_nav", file_name="style/nav.css", media_type="text/css", content=style)
    book.add_item(nav_css)
    book.spine = ["nav", chapter]

    epub.write_epub(str(out_path), book, {})


def _export_pdf_basic(md_text: str, out_path: Path) -> None:
    # Basic text PDF fallback (no rich formatting).
    from reportlab.lib.pagesizes import LETTER
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    # Try to register a common CJK font if present; otherwise fallback.
    # Do NOT fail export if font is missing.
    try:
        # Microsoft YaHei is common on Windows.
        font_path = Path("C:/Windows/Fonts/msyh.ttc")
        if font_path.exists():
            pdfmetrics.registerFont(TTFont("msyh", str(font_path)))
            font_name = "msyh"
        else:
            font_name = "Helvetica"
    except Exception:
        font_name = "Helvetica"

    text = _strip_markdown(md_text)
    c = canvas.Canvas(str(out_path), pagesize=LETTER)
    width, height = LETTER
    x = 40
    y = height - 50
    c.setFont(font_name, 11)
    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        if y < 60:
            c.showPage()
            c.setFont(font_name, 11)
            y = height - 50
        c.drawString(x, y, line[:120])
        y -= 14
    c.save()


@router.post("")
def export_project(project_id: str, payload: dict[str, Any]) -> FileResponse:
    fmt = str(payload.get("format") or "docx").lower()
    if fmt not in ("docx", "epub", "pdf"):
        raise HTTPException(status_code=400, detail="format must be docx|epub|pdf")

    with get_session() as session:
        project = session.get(Project, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        chapters = list(
            session.exec(
                select(Chapter)
                .where(Chapter.project_id == project_id)
                .order_by(Chapter.chapter_index.asc(), Chapter.created_at.asc())
            )
        )
        if not chapters:
            raise HTTPException(status_code=400, detail="No chapters to export")

    md_text = _compile_markdown(project, chapters)
    out_dir = _exports_dir()
    base = f"{project.title}_{_now_tag()}".replace(" ", "_")
    md_path = out_dir / f"{base}.md"
    md_path.write_text(md_text, encoding="utf-8")

    out_path = out_dir / f"{base}.{fmt}"

    try:
        if _pandoc_available() and fmt in ("docx", "epub"):
            _export_with_pandoc(md_path, out_path)
        elif fmt == "docx":
            _export_docx_basic(md_text, out_path)
        elif fmt == "epub":
            _export_epub_basic(project, md_text, out_path)
        else:
            _export_pdf_basic(md_text, out_path)
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"pandoc_failed: {e.stderr[:200].decode('utf-8', 'ignore')}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"export_failed:{type(e).__name__}")

    return FileResponse(
        path=str(out_path),
        media_type="application/octet-stream",
        filename=out_path.name,
    )

