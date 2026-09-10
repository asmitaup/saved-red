#!/usr/bin/env python3
"""
Fix categories that disagree with your own Instagram collection labels.

The original category pass was keyword-based and got plenty wrong —
e.g. a post you filed under your own "Love" collection in Instagram
landing in the app's "Quotes & Motivation" or "Comedy & Memes"
category instead, just because its caption/hashtags happened to match
those keywords better. Your own collection is the clearer signal, so
this rewrites `category` to match it wherever that mapping is
unambiguous (see COLLECTION_TO_CATEGORY in import_saved_posts.py for
exactly which collections qualify, and why the rest were left alone).

This only touches js/data.js. Any category you've already hand-edited
in the app itself lives in the browser's localStorage, not data.js,
and always wins at render time — so this can't undo your own edits.

Usage:
    python3 tools/recategorize_from_collections.py            # apply
    python3 tools/recategorize_from_collections.py --dry-run   # preview only
"""
import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from import_saved_posts import COLLECTION_TO_CATEGORY, category_from_collections  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_JS = REPO_ROOT / 'js' / 'data.js'
DATA_JS_RE = re.compile(r'^const RAW_ROWS = (\[.*\]);\s*$', re.S)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--data-js', type=Path, default=DEFAULT_DATA_JS)
    ap.add_argument('--dry-run', action='store_true', help="Report what would change without writing")
    args = ap.parse_args()

    src = args.data_js.read_text(encoding='utf-8')
    m = DATA_JS_RE.match(src)
    if not m:
        sys.exit(f"Couldn't find `const RAW_ROWS = [...]` in {args.data_js}")
    rows = json.loads(m.group(1))

    transitions = Counter()  # (old_cat, new_cat) -> count
    changed = 0
    for row in rows:
        collections = row[8].split('|') if row[8] else []
        new_cat = category_from_collections(collections)
        if new_cat and new_cat != row[7]:
            transitions[(row[7], new_cat)] += 1
            row[7] = new_cat
            changed += 1

    if changed == 0:
        print("No mismatches found against your collection labels — nothing to change.")
        return

    print(f"{changed:,} post(s) recategorized to match your Instagram collection labels:\n")
    for (old, new), n in sorted(transitions.items(), key=lambda kv: -kv[1]):
        print(f"  {n:>5}  {old} -> {new}")

    unmapped = sorted({c.strip() for row in rows for c in (row[8].split('|') if row[8] else [])
                        if c.strip().lower() not in COLLECTION_TO_CATEGORY})
    if unmapped:
        print(f"\n({len(unmapped)} of your collections were left alone as ambiguous/generic — "
              f"see the comment above COLLECTION_TO_CATEGORY in import_saved_posts.py for the full list "
              f"and why, e.g.: {', '.join(unmapped[:8])}{', ...' if len(unmapped) > 8 else ''})")

    if args.dry_run:
        print("\n(--dry-run, nothing written)")
        return

    body = json.dumps(rows, ensure_ascii=False, separators=(',', ':'))
    args.data_js.write_text(f'const RAW_ROWS = {body};\n', encoding='utf-8')
    print(f"\nWrote {args.data_js}. Reload the app to see the changes.")


if __name__ == '__main__':
    main()
