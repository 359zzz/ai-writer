from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx


DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/122.0.0.0 Safari/537.36"
)


@dataclass(frozen=True)
class WebSearchResult:
    title: str
    url: str
    snippet: str

    def as_dict(self) -> dict[str, Any]:
        return {"title": self.title, "url": self.url, "snippet": self.snippet}


class WebSearchError(RuntimeError):
    def __init__(self, message: str, errors: list[str] | None = None):
        super().__init__(message)
        self.errors = errors or []


def _clean_text(s: str) -> str:
    return " ".join((s or "").split()).strip()


def _search_bing(query: str, limit: int) -> list[WebSearchResult]:
    """
    Scrape Bing SERP HTML (no API key required).

    We use cn.bing.com because it tends to be reachable in more networks than DDG.
    """
    try:
        # Optional dependency; added to requirements for robustness.
        from bs4 import BeautifulSoup  # type: ignore
    except Exception as e:  # pragma: no cover
        raise WebSearchError(
            "missing_dependency: beautifulsoup4",
            errors=[type(e).__name__],
        ) from e

    url = "https://cn.bing.com/search"
    headers = {
        "User-Agent": DEFAULT_UA,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    with httpx.Client(headers=headers, timeout=httpx.Timeout(12.0, connect=6.0)) as client:
        resp = client.get(url, params={"q": query})
        resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")
    out: list[WebSearchResult] = []

    for li in soup.select("li.b_algo"):
        a = li.select_one("h2 a")
        if not a:
            continue
        href = _clean_text(a.get("href") or "")
        title = _clean_text(a.get_text(" ", strip=True))
        if not href or not title:
            continue
        snippet = ""
        p = li.select_one(".b_caption p") or li.select_one("p")
        if p:
            snippet = _clean_text(p.get_text(" ", strip=True))
        out.append(WebSearchResult(title=title, url=href, snippet=snippet))
        if len(out) >= limit:
            break

    return out


def _search_duckduckgo(query: str, limit: int) -> list[WebSearchResult]:
    # duckduckgo_search is already in requirements; still may be blocked by network.
    from duckduckgo_search import DDGS  # type: ignore

    headers = {
        "User-Agent": DEFAULT_UA,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    out: list[WebSearchResult] = []
    with DDGS(headers=headers, timeout=8) as ddgs:
        for r in ddgs.text(query, max_results=limit):
            title = _clean_text(str(r.get("title") or ""))
            href = _clean_text(str(r.get("href") or r.get("url") or ""))
            snippet = _clean_text(str(r.get("body") or r.get("snippet") or ""))
            if not title or not href:
                continue
            out.append(WebSearchResult(title=title, url=href, snippet=snippet))
            if len(out) >= limit:
                break
    return out


def web_search(
    query: str,
    *,
    limit: int = 5,
    provider: str = "auto",
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """
    Perform a lightweight web search and return (results, meta).

    meta fields:
    - provider_requested
    - provider_used
    - errors: list[str] (provider:error_type)
    """
    q = _clean_text(query)
    if not q:
        raise WebSearchError("q is required")
    limit = max(1, min(int(limit), 10))

    provider_norm = (provider or "auto").strip().lower()
    if provider_norm in {"ddg", "duckduckgo"}:
        providers = ["duckduckgo"]
    elif provider_norm in {"bing"}:
        providers = ["bing"]
    else:
        # "auto" prefers Bing first because DDG is blocked in some regions and will timeout.
        providers = ["bing", "duckduckgo"]

    errors: list[str] = []
    for p in providers:
        try:
            if p == "bing":
                res = _search_bing(q, limit)
                return [r.as_dict() for r in res], {
                    "provider_requested": provider_norm,
                    "provider_used": "bing",
                    "errors": errors,
                }
            if p == "duckduckgo":
                res = _search_duckduckgo(q, limit)
                return [r.as_dict() for r in res], {
                    "provider_requested": provider_norm,
                    "provider_used": "duckduckgo",
                    "errors": errors,
                }
        except Exception as e:
            errors.append(f"{p}:{type(e).__name__}")

    raise WebSearchError(
        "web_search_failed",
        errors=errors,
    )

