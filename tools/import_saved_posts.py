#!/usr/bin/env python3
"""
Import new Instagram saved posts into js/data.js.

Instagram doesn't offer an API for pulling your own saved posts, so
there's no way for the app itself to sync automatically — this script
is the "drop a fresh export in" half of that workflow. Re-run it any
time after you've saved more posts:

  1. In Instagram: Settings > Accounts Center > Your information and
     permissions > Download your information > Download or transfer
     information > select "Saved" (both "Posts" and "Collections") >
     format: HTML.
  2. Once Instagram emails you the download, unzip it and find
     saved_posts.html and saved_collections.html (they're both under
     your_instagram_activity/saved/ or similar, depending on how
     Instagram packaged it that time).
  3. Run this script pointed at them:

       python3 tools/import_saved_posts.py \\
           --posts ~/Downloads/saved_posts.html \\
           --collections ~/Downloads/saved_collections.html

     (Both flags default to exactly those paths, so if you just
     unzipped into ~/Downloads, `python3 tools/import_saved_posts.py`
     with no arguments works as-is.)

It's safe to run against the same export more than once — posts
already in js/data.js (matched by Instagram shortcode) are skipped,
so only genuinely new saves get added.

New posts land in whatever category this script's keyword guesser
picks, defaulting to "Uncategorized" when nothing matches — same as
~43% of the original import (see README). This is NOT the same
AI-assisted pass the original 26,634 posts got; it's a plain
keyword/hashtag match against each category name. Expect it to be
rougher than the original categorization. Use the app's own "Select
multiple" bulk-move (same tool used to sort the original
Uncategorized pile) to clean up afterward — or ask Claude to look at
the new batch and suggest categories directly.
"""
import argparse
import html
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_POSTS_HTML = Path.home() / 'Downloads' / 'saved_posts.html'
DEFAULT_COLLECTIONS_HTML = Path.home() / 'Downloads' / 'saved_collections.html'
DEFAULT_DATA_JS = REPO_ROOT / 'js' / 'data.js'
DEFAULT_SYNC_META_JS = REPO_ROOT / 'js' / 'sync-meta.js'

# ---------- HTML parsing ----------
# Both export files embed each saved post the same way: a small table
# with "URL" / "Caption" rows, a "Hashtags" list, and a nested "Owner"
# table. Rather than a full DOM parse (these files run 30-100MB+),
# we split on the "URL" marker that starts every entry and pull the
# handful of fields we need out of each chunk with targeted regexes —
# tested to parse the full 82MB/26,634-post export in under a second.

URL_RE = re.compile(
    r'<td colspan="2" class="_a6_q">URL<div><a target="_blank" '
    r'href="https://www\.instagram\.com/(p|reel)/([A-Za-z0-9_-]+)/?">'
)
CAPTION_RE = re.compile(r'<td class="_a6_q">Caption</td><td class="_2piu _a6_r">(.*?)</td>', re.S)
HASHTAG_BLOCK_RE = re.compile(r'<h2[^>]*>Hashtags</h2>(.*?)(?=<h2|\Z)', re.S)
NAME_DIV_RE = re.compile(r'<div class="_a6-p">([^<]*)</div>')
OWNER_USERNAME_RE = re.compile(
    r'<h2[^>]*>Owner</h2>.*?<td class="_a6_q">Username</td><td class="_2piu _a6_r">([^<]*)</td>', re.S
)
DATE_RE = re.compile(r'<div class="_3-94 _a6-o">([^<]*)</div>')
COLLECTION_NAME_RE = re.compile(
    r'<td class="_a6_q">Name</td><td class="_2piu _a6_r">([^<]*)</td></tr><tr><td class="_a6_q">Type</td>'
)
TAG_RE = re.compile(r'<[^>]+>')


def clean_text(s):
    return html.unescape(TAG_RE.sub('', s)).strip()


def split_entries(html_text):
    """Yield (type, shortcode, chunk) for every post entry in the file."""
    matches = list(URL_RE.finditer(html_text))
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(html_text)
        yield m.group(1), m.group(2), html_text[start:end]


def parse_posts_html(path):
    """-> dict shortcode -> {type, caption, hashtags, owner, date}"""
    text = path.read_text(encoding='utf-8')
    posts = {}
    for typ, shortcode, chunk in split_entries(text):
        if shortcode in posts:
            continue  # saved_posts.html shouldn't repeat a post, but be defensive
        cap_m = CAPTION_RE.search(chunk)
        caption = clean_text(cap_m.group(1)) if cap_m else ''
        hb_m = HASHTAG_BLOCK_RE.search(chunk)
        hashtags = [clean_text(h) for h in NAME_DIV_RE.findall(hb_m.group(1))] if hb_m else []
        owner_m = OWNER_USERNAME_RE.search(chunk)
        owner = clean_text(owner_m.group(1)) if owner_m else ''
        date_m = DATE_RE.search(chunk)
        date = clean_text(date_m.group(1)) if date_m else ''
        posts[shortcode] = {
            'type': typ, 'caption': caption, 'hashtags': hashtags, 'owner': owner, 'date': date,
        }
    return posts


def parse_collections_html(path):
    """-> dict shortcode -> [collection names], preserving encounter order."""
    text = path.read_text(encoding='utf-8')
    collection_matches = list(COLLECTION_NAME_RE.finditer(text))
    shortcode_to_collections = {}
    for i, m in enumerate(collection_matches):
        name = clean_text(m.group(1))
        start = m.end()
        end = collection_matches[i + 1].start() if i + 1 < len(collection_matches) else len(text)
        chunk = text[start:end]
        for _typ, shortcode, _entry_chunk in split_entries(chunk):
            names = shortcode_to_collections.setdefault(shortcode, [])
            if name not in names:
                names.append(name)
    return shortcode_to_collections


# ---------- Category heuristic ----------
# A plain keyword match against each category name — see the module
# docstring for why this isn't the same as the original categorization.
CATEGORY_KEYWORDS = {
    "Fashion & Style": ["fashion", "style", "outfit", "ootd", "ootn", "dress", "clothing", "clothes", "wear", "streetwear", "styling", "wardrobe", "outfitideas"],
    "Art & Design": ["art", "design", "illustration", "artist", "drawing", "painting", "sketch", "graphicdesign", "artwork", "digitalart", "illustrator"],
    "Weddings": ["wedding", "bride", "groom", "bridal", "weddingday", "weddingphotography", "engagement", "shaadi", "mehendi", "haldi"],
    "Love": ["love", "couple", "couples", "relationship", "boyfriend", "girlfriend", "romance", "romantic", "valentine"],
    "Travel": ["travel", "wanderlust", "vacation", "explore", "trip", "traveling", "travelgram", "tourism", "destination", "backpacking"],
    "Home & Decor": ["homedecor", "interior", "decor", "interiordesign", "homedesign", "furniture", "apartment", "livingroom", "houseideas"],
    "Beauty & Skincare": ["beauty", "skincare", "makeup", "skin", "cosmetics", "glowup", "selfcare", "skincareroutine", "skincaretips"],
    "Pets & Animals": ["pets", "dog", "cat", "puppy", "kitten", "animal", "dogsofinstagram", "catsofinstagram", "doglover", "petsofinstagram"],
    "Quotes & Motivation": ["quotes", "motivation", "inspiration", "mindset", "selflove", "affirmation", "quoteoftheday", "motivational"],
    "Food & Recipes": ["food", "recipe", "cooking", "foodie", "recipes", "baking", "yummy", "foodphotography", "kitchen", "delicious"],
    "Comedy & Memes": ["meme", "funny", "comedy", "lol", "humor", "relatable", "joke", "memes", "comedyvideo"],
    "Books & Reading": ["books", "reading", "bookstagram", "book", "booklover", "bookrecommendations", "novel", "bookworm"],
    "Movies & TV": ["movie", "tvshow", "film", "series", "netflix", "cinema", "movies", "tvseries", "actor", "actress"],
    "DIY & Crafts": ["diy", "crafts", "handmade", "craft", "howto", "tutorial", "upcycle", "diyproject"],
    "Nature & Plants": ["nature", "plants", "garden", "plant", "gardening", "outdoors", "hiking", "flowers", "plantsofinstagram"],
    "Music": ["music", "song", "musician", "concert", "playlist", "singer", "musicvideo", "musiclover"],
    "Fitness & Health": ["fitness", "workout", "health", "gym", "exercise", "wellness", "yoga", "fitnessmotivation"],
    "Business & Finance": ["business", "finance", "money", "entrepreneur", "investing", "marketing", "startup", "entrepreneurship"],
    "Tech & AI": ["tech", " ai ", "#ai", "technology", "artificialintelligence", "coding", "software", "gadget", "machinelearning"],
}


# ---------- Collection -> category mapping ----------
# When you've already organized a post into one of your own named
# Instagram collections, that's a clearer signal of what it's about
# than any hashtag guess — so it takes priority. Built by inspecting
# your actual 68 collections and their current (often wrong) category
# assignments; only included here where a collection's real content
# maps unambiguously to one category. Deliberately excludes:
#   - "Home" — Instagram's own default catch-all bucket, not a label
#     you chose, and its contents are all over the map.
#   - Collections whose posts turned out to be genuinely mixed on
#     inspection (Tattoo was reconsidered and included after checking —
#     see below; Journal, Italian, Rangoli, Portraits, Pujo, Kids,
#     Pink, Gifts, "Pretty pictures", "Favourite", "Lame", "Deepak
#     japan", "Durga pujo 24" were checked or judged too generic/mixed
#     and left alone).
# Keys are matched case-insensitively with whitespace trimmed, so
# "Germany " / "germany" / "New york" / "New York" all resolve.
COLLECTION_TO_CATEGORY = {
    # Travel — place names
    "travel - india": "Travel", "italy": "Travel", "germany": "Travel",
    "uk": "Travel", "new york": "Travel", "spain": "Travel", "japan": "Travel",
    "marrakech": "Travel", "san francisco": "Travel", "paris": "Travel",
    "holiday - abroad": "Travel",
    # Fashion & Style — clothing/textiles/jewelry (no dedicated category exists for either)
    "indie clothes": "Fashion & Style", "saree": "Fashion & Style",
    "clothes": "Fashion & Style", "suits": "Fashion & Style",
    "blouse and lehenga": "Fashion & Style", "fabrics": "Fashion & Style",
    "drape": "Fashion & Style", "jamdani": "Fashion & Style",
    "textiles and embroidery": "Fashion & Style", "jewelery": "Fashion & Style",
    "ring": "Fashion & Style", "him ring": "Fashion & Style",
    # Weddings — explicit "wedding" labels
    "wedding collection": "Weddings", "wedding decor": "Weddings",
    "wedding photography": "Weddings", "wedding saree": "Weddings",
    "wedding - haldi": "Weddings", "wedding stationery": "Weddings",
    "wedding gifts": "Weddings", "wedding him": "Weddings", "mandaps": "Weddings",
    # Direct 1:1 matches
    "love": "Love", "quotes": "Quotes & Motivation", "cat": "Pets & Animals",
    "book": "Books & Reading", "music": "Music", "movie": "Movies & TV",
    "ai": "Tech & AI", "excercise": "Fitness & Health",
    # Food & Recipes
    "cakes": "Food & Recipes", "food": "Food & Recipes", "recipes": "Food & Recipes",
    # Beauty & Skincare
    "auburn hair": "Beauty & Skincare", "hair": "Beauty & Skincare",
    "hair colour - red": "Beauty & Skincare", "makeup": "Beauty & Skincare",
    # Art & Design — checked Tattoo's actual captions: tattoo-artist/design
    # content, not skincare, despite the current category split suggesting otherwise.
    "art": "Art & Design", "illustrations": "Art & Design",
    "typography": "Art & Design", "couple illustration": "Art & Design",
    "tattoo": "Art & Design",
}


def category_from_collections(collections):
    """The single category implied by a post's own collection tags, or
    None if it has none, or if its collections imply more than one
    different category (genuinely ambiguous — don't guess)."""
    implied = {COLLECTION_TO_CATEGORY[c.strip().lower()] for c in collections if c.strip().lower() in COLLECTION_TO_CATEGORY}
    return implied.pop() if len(implied) == 1 else None


def guess_category(caption, hashtags, collections=()):
    from_collections = category_from_collections(collections)
    if from_collections:
        return from_collections
    text = ' ' + (caption or '').lower() + ' ' + ' '.join(h.lower() for h in hashtags) + ' '
    best_cat, best_score = None, 0
    for cat, keywords in CATEGORY_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in text)
        if score > best_score:
            best_cat, best_score = cat, score
    return best_cat or "Uncategorized"


# ---------- data.js read/write ----------
DATA_JS_RE = re.compile(r'^const RAW_ROWS = (\[.*\]);\s*$', re.S)


def load_existing_rows(data_js_path):
    src = data_js_path.read_text(encoding='utf-8')
    m = DATA_JS_RE.match(src)
    if not m:
        sys.exit(f"Couldn't find `const RAW_ROWS = [...]` in {data_js_path} — is the file format unchanged?")
    return json.loads(m.group(1))


def write_rows(data_js_path, rows):
    body = json.dumps(rows, ensure_ascii=False, separators=(',', ':'))
    data_js_path.write_text(f'const RAW_ROWS = {body};\n', encoding='utf-8')


def write_sync_meta(sync_meta_js_path):
    # A separate, tiny file (rather than a field inside data.js) so
    # stamping "you checked, and you're up to date" doesn't require
    # rewriting the whole multi-megabyte posts array when there's
    # nothing new to add. The app reads this to show "last synced" —
    # see js/app.js.
    now = datetime.now(timezone.utc).isoformat(timespec='seconds')
    sync_meta_js_path.write_text(f'const DATA_SYNCED_AT = "{now}";\n', encoding='utf-8')


def main():
    ap = argparse.ArgumentParser(description='Import new Instagram saved posts into js/data.js')
    ap.add_argument('--posts', type=Path, default=DEFAULT_POSTS_HTML, help='Path to saved_posts.html')
    ap.add_argument('--collections', type=Path, default=DEFAULT_COLLECTIONS_HTML, help='Path to saved_collections.html (optional)')
    ap.add_argument('--data-js', type=Path, default=DEFAULT_DATA_JS, help='Path to js/data.js to update')
    ap.add_argument('--sync-meta-js', type=Path, default=DEFAULT_SYNC_META_JS, help='Path to js/sync-meta.js to update (the "last synced" timestamp the app displays)')
    ap.add_argument('--dry-run', action='store_true', help="Report what would change without writing anything")
    args = ap.parse_args()

    if not args.posts.exists():
        sys.exit(f"Can't find {args.posts} — pass --posts pointing at your saved_posts.html export.")

    existing_rows = load_existing_rows(args.data_js)
    existing_shortcodes = {row[1] for row in existing_rows}
    print(f"Existing library: {len(existing_rows):,} posts")

    print(f"Parsing {args.posts.name}...")
    posts = parse_posts_html(args.posts)
    print(f"  found {len(posts):,} posts in the export")

    collections_map = {}
    if args.collections.exists():
        print(f"Parsing {args.collections.name}...")
        collections_map = parse_collections_html(args.collections)
        print(f"  found collection tags for {len(collections_map):,} posts")
    else:
        print(f"(No collections file at {args.collections} — new posts will have no `collections` tags.)")

    new_rows = []
    category_tally = {}
    for shortcode, p in posts.items():
        if shortcode in existing_shortcodes:
            continue
        category = guess_category(p['caption'], p['hashtags'], collections_map.get(shortcode, []))
        category_tally[category] = category_tally.get(category, 0) + 1
        row = [
            shortcode,  # id — new imports use the shortcode itself as a stable, unique id
            shortcode,
            p['type'],
            p['caption'],
            p['owner'],
            p['date'],
            '|'.join(p['hashtags']),
            category,
            '|'.join(collections_map.get(shortcode, [])),
        ]
        new_rows.append(row)

    if not new_rows:
        print("\nNo new posts — js/data.js is already up to date with this export.")
        if not args.dry_run:
            write_sync_meta(args.sync_meta_js)
            print("Stamped \"last synced\" as now — the app will show you checked today.")
        return

    print(f"\n{len(new_rows):,} new post(s) to add:")
    for cat, n in sorted(category_tally.items(), key=lambda kv: -kv[1]):
        print(f"  {cat}: {n}")

    if args.dry_run:
        print("\n(--dry-run, nothing written)")
        return

    write_rows(args.data_js, existing_rows + new_rows)
    write_sync_meta(args.sync_meta_js)
    print(f"\nWrote {args.data_js} — {len(existing_rows) + len(new_rows):,} posts total.")
    print("Reload the app to see them (no server restart needed).")


if __name__ == '__main__':
    main()
