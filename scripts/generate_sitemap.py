#!/usr/bin/env python3
"""Build sitemap.xml from public HTML pages and their content dates."""

from __future__ import annotations

import re
import subprocess
from datetime import date
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://spark-fit.com"
EXCLUDED = {"404.html", "unsubscribe.html", "app/index.html", "guide/thank-you.html"}


def route_for(path: Path) -> str:
    relative = path.relative_to(ROOT).as_posix()
    if relative == "index.html":
        return "/"
    if relative.endswith("/index.html"):
        return "/" + relative[: -len("index.html")]
    return "/" + relative


def git_date(path: Path) -> str:
    result = subprocess.run(
        ["git", "log", "-1", "--format=%cs", "--", str(path.relative_to(ROOT))],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() or date.today().isoformat()


def content_date(path: Path) -> str:
    html = path.read_text(encoding="utf-8")
    match = re.search(r'"dateModified"\s*:\s*"(\d{4}-\d{2}-\d{2})"', html)
    if match:
        return match.group(1)
    if path == ROOT / "blog" / "index.html":
        dates = re.findall(r">(\d{4}-\d{2}-\d{2})</p>", html)
        if dates:
            return max(dates)
    return git_date(path)


def main() -> None:
    pages = []
    for path in ROOT.rglob("*.html"):
        relative = path.relative_to(ROOT).as_posix()
        if relative in EXCLUDED or ".git" in path.parts:
            continue
        html = path.read_text(encoding="utf-8")
        if re.search(r'<meta[^>]+name=["\']robots["\'][^>]+noindex', html, re.I):
            continue
        pages.append((route_for(path), content_date(path)))

    pages.sort(key=lambda item: (item[0] != "/", item[0]))
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for route, modified in pages:
        lines.append(f"  <url><loc>{escape(BASE + route)}</loc><lastmod>{modified}</lastmod></url>")
    lines.append("</urlset>")
    (ROOT / "sitemap.xml").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {len(pages)} public URLs to sitemap.xml")


if __name__ == "__main__":
    main()
