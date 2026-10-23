#!/usr/bin/env python3
"""Create WebP variants and give local HTML images intrinsic dimensions."""

from __future__ import annotations

import re
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def local_path(page: Path, src: str) -> Path | None:
    if src.startswith(("http://", "https://", "data:")):
        return None
    if src.startswith("/"):
        return ROOT / src.lstrip("/")
    return (page.parent / src).resolve()


def optimize_tag(page: Path, match: re.Match[str]) -> str:
    tag = match.group(0)
    src_match = re.search(r'\bsrc="([^"]+)"', tag)
    if not src_match:
        return tag
    src = src_match.group(1)
    image_path = local_path(page, src)
    if not image_path or not image_path.exists():
        return tag

    with Image.open(image_path) as image:
        width, height = image.size
        if image_path.suffix.lower() in {".png", ".jpg", ".jpeg"}:
            webp_path = image_path.with_suffix(".webp")
            if not webp_path.exists() or webp_path.stat().st_mtime < image_path.stat().st_mtime:
                image.save(webp_path, "WEBP", quality=82, method=6)
            new_src = src.rsplit(".", 1)[0] + ".webp"
            tag = tag.replace(f'src="{src}"', f'src="{new_src}"', 1)
    if not re.search(r"\bwidth=", tag):
        tag = tag[:-1] + f' width="{width}">'
    if not re.search(r"\bheight=", tag):
        tag = tag[:-1] + f' height="{height}">'
    return tag


def main() -> None:
    pages = list(ROOT.rglob("*.html"))
    for page in pages:
        source = page.read_text(encoding="utf-8")
        updated = re.sub(r"<img\b[^>]*>", lambda match: optimize_tag(page, match), source)
        page.write_text(updated, encoding="utf-8")
    print(f"Optimized local images across {len(pages)} HTML files")


if __name__ == "__main__":
    main()
