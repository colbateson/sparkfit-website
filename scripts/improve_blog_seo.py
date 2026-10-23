#!/usr/bin/env python3
"""Apply and validate the shared SEO/editorial contract for static blog pages."""

from __future__ import annotations

import html
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BLOG = ROOT / "blog"
AUTHOR_URL = "https://spark-fit.com/author/colin-bateson/"
EDITORIAL_URL = "https://spark-fit.com/editorial-policy.html"
ORG = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": "https://spark-fit.com/#organization",
    "name": "SparkFit",
    "url": "https://spark-fit.com/",
    "logo": "https://spark-fit.com/icon.png",
    "sameAs": [
        "https://apps.apple.com/gb/app/sparkfit-15-min-workouts/id6754826325",
        "https://play.google.com/store/apps/details?id=app.spark.fit",
    ],
}

TITLE_OVERRIDES = {
    "how-to-meal-prep-in-under-30-minutes-simple-nutrition-for-fat-loss.html": "30-Minute Meal Prep for Fat Loss",
    "how-to-meal-prep-in-under-30-minutes-simple-nutrition-for-busy-adults.html": "30-Minute Meal Prep for Busy Adults",
    "how-to-meal-prep-for-fat-loss-simple-15-minute-recipes-for-busy-people.html": "15-Minute Fat-Loss Recipes for Busy People",
    "how-to-meal-prep-for-fat-loss-simple-15-minute-recipes-for-busy-adults.html": "15-Minute Meal Prep for Busy Adults",
    "15-minute-strength-workouts-for-beginners-build-muscle-at-home-with-minimal-equi.html": "Beginner Strength Workouts with Minimal Equipment",
    "15-minute-strength-workouts-for-beginners-build-muscle-at-home-with-no-equipment.html": "Beginner Strength Workouts with No Equipment",
    "meal-planning-for-realistic-fat-loss-simple-steps-for-busy-people.html": "Simple Fat-Loss Meal Planning for Busy People",
    "meal-planning-for-realistic-fat-loss-one-week-of-simple-dinners.html": "One Week of Simple Fat-Loss Dinners",
    "how-to-build-strength-at-home-with-minimal-equipment-15-minute-beginner-friendly.html": "Beginner Home Strength with Minimal Equipment",
    "how-to-build-strength-at-home-with-minimal-equipment-15-minute-dumbbell-workouts.html": "15-Minute Dumbbell Strength with Minimal Equipment",
    "simple-meal-prep-ideas-for-busy-adults-5-ingredients-or-less.html": "Five-Ingredient Meal Prep for Busy Adults",
    "simple-meal-prep-ideas-for-busy-adults-15-minute-high-protein-recipes.html": "15-Minute High-Protein Meal Prep Recipes",
    "simple-meal-prep-ideas-for-busy-adults-5-quick-recipes-to-support-fat-loss.html": "Five Quick Meal-Prep Recipes for Fat Loss",
    "15-minute-dumbbell-workouts-for-strength-at-home.html": "15-Minute Dumbbell Workouts for Home Strength",
    "15-minute-dumbbell-workouts-strength-at-home.html": "Build Strength at Home with 15-Minute Dumbbell Workouts",
    "simple-meal-prep-ideas-for-fat-loss-quick-recipes-for-busy-adults.html": "Quick Fat-Loss Meal Prep for Busy Adults",
    "simple-meal-prep-ideas-for-fat-loss-5-quick-recipes.html": "Five Quick Meal-Prep Recipes for Fat Loss",
}


def plain(value: str) -> str:
    value = re.sub(r"<[^>]+>", "", value)
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def fit_title(headline: str) -> str:
    candidates = [headline.split(":", 1)[0].strip(), headline]
    for candidate in candidates:
        if 30 <= len(candidate) <= 60:
            return candidate
    words = headline.split()
    result = ""
    for word in words:
        proposed = f"{result} {word}".strip()
        if len(proposed) > 57:
            break
        result = proposed
    if len(result) < 30:
        result = (result + " | SparkFit").strip()
    return result.rstrip(" :,-")


def fit_description(source: str) -> str:
    text = plain(source)
    text = re.sub(r"^(Discover|Learn)\s+", "", text, flags=re.I)
    if len(text) < 110:
        text += " The guide includes clear steps you can use at home or in the gym."
    if len(text) > 160:
        text = text[:157].rsplit(" ", 1)[0].rstrip(" ,;:") + "."
    return text


def update_article(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    h1 = re.search(r"<h1[^>]*>(.*?)</h1>", source, re.S)
    hero_intro = re.search(r'<p class="text-lg md:text-xl[^>]*>(.*?)</p>', source, re.S)
    if not h1 or not hero_intro:
        raise ValueError(f"Missing headline or opening paragraph: {path}")
    headline = plain(h1.group(1))
    title = TITLE_OVERRIDES.get(path.name, fit_title(headline))
    description = fit_description(hero_intro.group(1))

    source = re.sub(r"<title>.*?</title>", f"<title>{html.escape(title)}</title>", source, count=1, flags=re.S)
    source = re.sub(
        r'<meta name="description" content="[^"]*">',
        f'<meta name="description" content="{html.escape(description, quote=True)}">',
        source,
        count=1,
    )

    # Remove decorative hot-linked product images. The product names and links remain.
    source = re.sub(r'<img\s+src="https://m\.media-amazon\.com/[^"]+"[^>]*>', "", source)
    source = source.replace(
        "<h2 class=\"text-2xl md:text-3xl font-black tracking-tight mb-4\">Helpful kit for this article</h2>",
        "<h2 class=\"text-2xl md:text-3xl font-black tracking-tight mb-4\">What equipment could help?</h2>",
    )
    source = source.replace(
        '<p class="text-gray-600">A few practical picks that can help you put this advice into action. SparkFit may earn a commission if you buy through these links.</p>',
        '<p class="text-gray-600">The useful equipment depends on the plan below. These optional picks support the exercises; SparkFit may earn a commission from qualifying purchases.</p>',
    )
    source = source.replace(
        '<h2 class="text-2xl font-black mb-3">SparkFit CTA</h2>',
        '<h2 class="text-2xl font-black mb-3">Want a 15-minute plan to follow?</h2>',
    )

    endings = [
        "The steps below show what to do first, how to fit the plan into a busy week and which details make the biggest practical difference.",
        "Use the plan below to choose a realistic starting point, avoid wasted effort and make the routine work around a busy schedule.",
        "The guide below turns that answer into clear actions, including a sensible starting point and the details that matter when time is limited.",
        "The sections below explain the useful first step, the common mistakes to avoid and how to keep the plan manageable during a busy week.",
        "Follow the steps below for a practical starting point, simple progress checks and a routine that does not depend on having lots of spare time.",
        "The plan below covers the first useful action, what to adjust as you progress and how to stay consistent without making the routine complicated.",
    ]
    ending = endings[int(hashlib.sha1(path.name.encode()).hexdigest(), 16) % len(endings)]
    direct_answer = description.rstrip(".") + ". " + ending
    intro_pattern = r'(<h2[^>]*>Introduction</h2>\s*)<p>.*?</p>'
    source = re.sub(intro_pattern, r"\1<p>" + html.escape(direct_answer) + "</p>", source, count=1, flags=re.S)

    source = re.sub(r"<p>\s*This\s+", "<p>The approach ", source)
    source = re.sub(r"<p>\s*They\s+", "<p>The exercises ", source)
    source = re.sub(r"<p>\s*Such an approach\s+", "<p>A practical approach ", source, flags=re.I)

    # Repair an empty nested JSON-LD block left by an earlier generator.
    source = re.sub(
        r'<script type="application/ld\+json">\s*<script type="application/ld\+json">\s*\{\}\s*</script>',
        "",
        source,
        flags=re.S,
    )

    blocks = list(re.finditer(r'<script type="application/ld\+json">\s*(\{.*?\})\s*</script>', source, re.S))
    article_match = None
    article_data = None
    for block in blocks:
        try:
            data = json.loads(block.group(1))
        except json.JSONDecodeError:
            continue
        if data.get("@type") == "Article":
            article_match, article_data = block, data
            break
    if not article_match or not article_data:
        raise ValueError(f"Missing valid Article JSON-LD: {path}")

    article_data["description"] = description
    article_data["author"] = {
        "@type": "Person",
        "@id": AUTHOR_URL + "#person",
        "name": "Colin Bateson",
        "url": AUTHOR_URL,
        "sameAs": ["https://github.com/colbateson"],
    }
    article_data["publisher"] = {"@id": "https://spark-fit.com/#organization"}
    replacement = '<script type="application/ld+json">\n' + json.dumps(article_data, indent=2, ensure_ascii=False) + "\n</script>"
    source = source[: article_match.start()] + replacement + source[article_match.end() :]

    org_block = '<script type="application/ld+json">\n' + json.dumps(ORG, indent=2) + "\n</script>"
    if '"@type": "Organization",\n  "@id": "https://spark-fit.com/#organization"' not in source:
        source = source.replace(replacement, replacement + "\n" + org_block, 1)

    time_row = re.search(r'(<div class="flex flex-wrap gap-3 text-sm text-gray-500 font-bold mt-7">.*?</div>)', source, re.S)
    if time_row and AUTHOR_URL not in time_row.group(1):
        new_row = time_row.group(1).replace(
            "</div>",
            f'<span>Reviewed by <a href="{AUTHOR_URL}" class="underline">Colin Bateson</a></span>'
            f'<a href="{EDITORIAL_URL}" class="underline">Editorial process</a></div>',
        )
        source = source[: time_row.start()] + new_row + source[time_row.end() :]

    path.write_text(source, encoding="utf-8")

    if not 30 <= len(title) <= 60:
        raise ValueError(f"Title length {len(title)} in {path}: {title}")
    if not 110 <= len(description) <= 160:
        raise ValueError(f"Description length {len(description)} in {path}")


def main() -> None:
    articles = sorted(path for path in BLOG.glob("*.html") if path.name != "index.html")
    for article in articles:
        update_article(article)
    print(f"Updated and validated {len(articles)} articles")


if __name__ == "__main__":
    main()
