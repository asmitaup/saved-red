# Saved — Instagram archive organizer

A local, static web app for browsing your exported Instagram saved posts,
with AI-suggested categories you can edit, search, and live previews.

## What's in here

```
index.html        Page shell — links css/js, no logic
css/style.css      All styling
js/data.js         Your 26,634 saved posts, parsed from Instagram's export
                    (exposes a single `RAW_ROWS` array)
js/app.js          All app logic: filtering, search, categorizing,
                    previews, localStorage persistence
tools/import_saved_posts.py
                    Re-import script — adds newly-saved posts to
                    js/data.js from a fresh Instagram export
```

## Adding posts you save later

Instagram doesn't offer an API for pulling your own saved posts, so
there's no way for the app to sync itself automatically — re-exporting
periodically and running the import script is the actual mechanism:

1. In Instagram: **Settings > Accounts Center > Your information and
   permissions > Download your information > Download or transfer
   information** > select **Saved** (both "Posts" and "Collections")
   > format **HTML**.
2. Once Instagram emails the download, unzip it and find
   `saved_posts.html` and `saved_collections.html`.
3. Run:
   ```
   python3 tools/import_saved_posts.py --posts ~/Downloads/saved_posts.html --collections ~/Downloads/saved_collections.html
   ```
   (Both flags default to exactly those two paths in `~/Downloads`, so
   if that's where you unzipped to, plain `python3
   tools/import_saved_posts.py` works with no arguments. Add
   `--dry-run` first if you just want to see what it would do.)

It's safe to run against the same export more than once — posts
already in `js/data.js` (matched by Instagram shortcode) are skipped,
so only genuinely new saves get added. No server restart needed
afterward — just reload the app.

New posts get a rough category guess from a plain keyword/hashtag
match (see the script's own docstring) — **not** the same
AI-assisted pass the original 26,634 got, so expect it to be rougher
and more will land in "Uncategorized." Sort those with **Select
multiple** on the detail screen, same as you would have with the
original import's uncategorized pile — or ask Claude to look at the
new batch and suggest categories directly.

## Running it

It's plain HTML/CSS/JS — no build step, no dependencies. Two ways to run it:

**Quickest — just open the file:**
```
open index.html
```
Works, but some browsers restrict local script-to-script loading
depending on security settings.

**More reliable — serve it locally** (also what Instagram's embed
widget expects, since it's less fussy about a real http:// origin):
```
python3 -m http.server 8000
```
Then visit `http://localhost:8000` in your browser.

If you're using this inside Claude Code, just ask it to run either of
the above from this folder.

## Data model

Each post in `js/data.js` is a row:
```
[id, shortcode, type, caption, owner, date, hashtags, category, collections]
```
`app.js` expands these into objects on load. `hashtags` and `collections`
are pipe-delimited strings (`"a|b|c"`) to keep the file smaller — split on
`|` to get arrays (already done for you in `app.js`).

- **category** — the AI-suggested broad category (editable in the UI;
  edits are saved to `localStorage`, not back into `data.js`)
- **collections** — any collections *you'd* already made in Instagram
  itself before exporting, preserved as read-only tags

## Persistence

Category edits and any custom categories you add are saved to the
browser's `localStorage` under the keys `saved-organizer:category-overrides`
and `saved-organizer:custom-categories`. This is per-browser, per-origin —
if you open the app from a different folder path or a different browser,
edits won't carry over. Back up `js/data.js` (or export the localStorage
keys) if you want a durable copy of your edits.

## Known limitations

- **No real thumbnails in the data itself.** Instagram's export is
  text-only (captions, hashtags, owner, URL) — there are no images or
  video files in it. The app compensates with on-scroll live previews
  (see below), not stored images.
- **Live previews use Instagram's own embed widget**
  (`instagram.com/embed.js`), loaded fresh from Instagram each time,
  one request per post, as it scrolls into view. This requires an
  internet connection and only works for posts that are still public.
  There's no way to bulk-fetch thumbnails for all 26K posts at once —
  Instagram doesn't offer that without an approved API app and a token,
  and even then it's rate-limited far below what this library would need.
  A toggle in the UI turns auto-loading off if it's too heavy on mobile
  data or a slow connection.
- **Categories are heuristic, not perfect.** They're assigned by matching
  hashtags/caption keywords against ~19 broad categories. About 43% of
  posts landed in "Uncategorized" because their text didn't clearly match
  any category — sort those manually as you like.
