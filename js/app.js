
const FIELDS = ['id','shortcode','type','caption','owner','date','hashtags','category','collections'];
let posts = RAW_ROWS.map(r => ({
  id:r[0], shortcode:r[1], type:r[2], caption:r[3], owner:r[4], date:r[5],
  hashtags: r[6] ? r[6].split('|') : [],
  category: r[7],
  collections: r[8] ? r[8].split('|') : []
}));
// O(1) lookup by id — needed so bulk operations on hundreds/thousands of
// selected posts don't each do an O(n) scan over the full 26k-post array.
const postsById = new Map(posts.map(p => [p.id, p]));

const CATEGORY_ORDER = ["Fashion & Style","Art & Design","Weddings","Love","Travel","Home & Decor","Beauty & Skincare","Pets & Animals","Quotes & Motivation","Food & Recipes","Comedy & Memes","Books & Reading","Movies & TV","DIY & Crafts","Nature & Plants","Music","Fitness & Health","Business & Finance","Tech & AI","Uncategorized"];

let overrides = {};
let customCategories = [];
// Which subcategory a post has been manually filed into — separate from
// `overrides` (main category) and from the post's own raw `collections`
// array (untouched either way). Keyed by post id; '' explicitly means
// "no subcategory, sits directly under the category" (distinct from the
// key being absent entirely, which means "no manual assignment — derive
// it the old way, from collections/CURATED_SUBCATS as before"). See
// subcategoriesFor()/matchesSubcat() below, and openCatSheet() for where
// this gets set from the move sheet's category → subcategory drill-in.
let subcatOverrides = {};
// User-created subcategory names, per category — e.g. { "Travel": ["Iceland"] }
// — so a freshly-created subcategory shows up as a move-sheet destination
// immediately, before any post has actually been filed into it yet.
let customSubcats = {};
let storageReady = false;

const LS_OVERRIDES = 'saved-organizer:category-overrides';
const LS_CUSTOM_CATS = 'saved-organizer:custom-categories';
const LS_SUBCAT_OVERRIDES = 'saved-organizer:subcat-overrides';
const LS_CUSTOM_SUBCATS = 'saved-organizer:custom-subcats';

function loadStorage(){
  try{
    const o = localStorage.getItem(LS_OVERRIDES);
    if(o) overrides = JSON.parse(o);
  }catch(e){}
  try{
    const c = localStorage.getItem(LS_CUSTOM_CATS);
    if(c) customCategories = JSON.parse(c);
  }catch(e){}
  try{
    const so = localStorage.getItem(LS_SUBCAT_OVERRIDES);
    if(so) subcatOverrides = JSON.parse(so);
  }catch(e){}
  try{
    const cs = localStorage.getItem(LS_CUSTOM_SUBCATS);
    if(cs) customSubcats = JSON.parse(cs);
  }catch(e){}
  storageReady = true;
  applyOverrides();
}

let saveTimer = null;
function persist(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try{ localStorage.setItem(LS_OVERRIDES, JSON.stringify(overrides)); }catch(e){}
    try{ localStorage.setItem(LS_CUSTOM_CATS, JSON.stringify(customCategories)); }catch(e){}
    try{ localStorage.setItem(LS_SUBCAT_OVERRIDES, JSON.stringify(subcatOverrides)); }catch(e){}
    try{ localStorage.setItem(LS_CUSTOM_SUBCATS, JSON.stringify(customSubcats)); }catch(e){}
  }, 400);
}

function applyOverrides(){
  for(const p of posts){
    if(overrides[p.id]) p.category = overrides[p.id];
  }
}

function allCategories(){
  const set = new Set(CATEGORY_ORDER);
  for(const c of customCategories) set.add(c);
  for(const p of posts) set.add(p.category);
  const known = CATEGORY_ORDER.filter(c => set.has(c));
  const extra = [...set].filter(c => !CATEGORY_ORDER.includes(c)).sort();
  return [...known, ...extra];
}

function counts(){
  const m = {};
  for(const p of posts) m[p.category] = (m[p.category]||0)+1;
  return m;
}

// ---------- Screens ----------
// 'splash' (first 5s) -> 'gallery' (categories as a photo-gallery grid)
// -> 'subgallery' (places under Travel, or the locked vault's contents)
// -> 'detail' (posts inside one category/subcategory, with a view switcher)
let currentScreen = 'splash';
function showScreen(name){
  currentScreen = name;
  document.getElementById('screen-splash').hidden = name !== 'splash';
  document.getElementById('screen-gallery').hidden = name !== 'gallery';
  document.getElementById('screen-subgallery').hidden = name !== 'subgallery';
  document.getElementById('screen-detail').hidden = name !== 'detail';
}

// Where the detail screen's "back" button should return to — set whenever
// we enter it, since it can be reached from the main gallery, a category's
// subgallery, or the vault's subgallery.
let cameFrom = 'gallery'; // 'gallery' | 'subgallery' | 'vault'

let activeCat = 'All';
let activeSubcat = null;
let query = '';
let visibleCount = 40;
const PAGE = 40;
let columnMode = 'list'; // 'list' (1 col) | 'two' (2 col) | 'grid' (responsive multi-col) — the detail-screen view switcher

// Triage / bulk-select — lets you narrow with a category + search
// (e.g. Uncategorized + "saree") then move every match in one action,
// instead of opening the category sheet once per post.
let triageMode = false;
let selectedIds = new Set();

function urlFor(p){
  return `https://www.instagram.com/${p.type}/${p.shortcode}/`;
}

function matchesQuery(p, q){
  if(!q) return true;
  q = q.toLowerCase();
  if(p.caption.toLowerCase().includes(q)) return true;
  if(p.owner.toLowerCase().includes(q)) return true;
  if(p.hashtags.some(h => h.toLowerCase().includes(q))) return true;
  if(p.category.toLowerCase().includes(q)) return true;
  return false;
}

// ---------- Sub-categories ----------
// The `collections` field is freeform and shared across the whole archive
// (e.g. "Love"/"Jewelery"/"Quotes" show up tagged on travel posts too), so
// naively grouping by collection would litter Travel with nonsense
// sub-folders. Curated per-category: hand-picked from the real data, each
// display label matches one or more raw collection values (merging
// near-duplicate casing like "New York"/"New york").
const CURATED_SUBCATS = {
  "Travel": [
    { label: "Italy", match: ["Italy"] },
    { label: "Germany", match: ["Germany"] },
    { label: "India", match: ["Travel - India"] },
    { label: "Paris", match: ["Paris"] },
    { label: "San Francisco", match: ["san francisco"] },
    { label: "New York", match: ["New York", "New york"] },
    { label: "Spain", match: ["Spain"] },
    { label: "Abroad", match: ["Holiday - Abroad"] },
  ],
};
// Categories not curated above fall back to this: group by raw collection
// value, ignoring anything that only appears once or twice (too noisy to
// be a real "sub-folder").
const AUTO_SUBCAT_MIN_COUNT = 3;

// A post's subcategory within its own category, before any manual
// override — curated categories match against CURATED_SUBCATS as
// before; everything else has no single "natural" label (a post can
// raw-match several collections at once there, tallied separately
// below), so this only applies to the curated path.
function naturalSubcat(p){
  const curated = CURATED_SUBCATS[p.category];
  if(!curated) return null;
  const def = curated.find(d => p.collections.some(c => d.match.includes(c)));
  return def ? def.label : null;
}

// includeEmpty:false (default, used for browsing the subgallery) — same
// behavior as before this app supported moving posts between
// subcategories: curated labels and auto-derived ones (>=3 raw-collection
// matches), each only listed once they actually have a post in them.
// includeEmpty:true (used by the move sheet's subcategory picker) also
// lists curated defs and user-created custom subcategories (see
// customSubcats) even with zero posts yet, so they're pickable as a
// destination right after creating them or before anything's been filed
// into them.
function subcategoriesFor(cat, includeEmpty){
  const curated = CURATED_SUBCATS[cat];
  const custom = customSubcats[cat] || [];
  const counts = {};
  const bump = (label) => { counts[label] = (counts[label] || 0) + 1; };
  const rawTally = {}; // auto-derive path only, subject to AUTO_SUBCAT_MIN_COUNT below

  for(const p of posts){
    if(p.category !== cat) continue;
    const ov = subcatOverrides[p.id];
    if(ov !== undefined){
      if(ov) bump(ov); // manually filed here — counts regardless of any threshold
      continue;
    }
    if(curated){
      const nat = naturalSubcat(p);
      if(nat) bump(nat);
    } else {
      for(const c of p.collections) rawTally[c] = (rawTally[c] || 0) + 1;
    }
  }
  if(!curated){
    for(const [label, n] of Object.entries(rawTally)){
      if(n >= AUTO_SUBCAT_MIN_COUNT) counts[label] = (counts[label] || 0) + n;
    }
  }
  if(includeEmpty){
    for(const label of custom){ if(!(label in counts)) counts[label] = 0; }
    if(curated){ for(const def of curated){ if(!(def.label in counts)) counts[def.label] = 0; } }
  }

  return Object.entries(counts)
    .map(([label, count]) => ({ label, count }))
    .filter(s => includeEmpty || s.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function matchesSubcat(p){
  if(!activeSubcat) return true;
  const ov = subcatOverrides[p.id];
  if(ov !== undefined) return ov === activeSubcat;
  const curated = CURATED_SUBCATS[activeCat];
  if(curated) return naturalSubcat(p) === activeSubcat;
  return p.collections.includes(activeSubcat);
}

// ---------- Locked folder (vault) ----------
// A client-side gate, not real security — there's no server to authenticate
// against in a static app, so anyone with access to the files on this Mac
// could still read the data directly. It just keeps a category out of
// casual view. The password is required on every single entry — no
// "stays unlocked for a while" grace period.
const LOCKED_CATEGORIES = ['Love', 'Weddings'];
const VAULT_HASH_KEY = 'saved-organizer:vault-hash';
function simpleHash(str){
  let h = 5381;
  for(let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function filtered(){
  return posts.filter(p => (activeCat === 'All' || p.category === activeCat) && matchesSubcat(p) && matchesQuery(p, query));
}

const EXTERNAL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>';

// ---------- Category icons ----------
// The export is text-only (captions/hashtags/urls, no images — see
// README), so there's no real photo to use as a category thumbnail.
// Each category instead gets a deterministic icon + color (same hue
// hash as the category badges) so the gallery still reads as a set of
// distinct, recognizable "album covers."
function svgIcon(inner){
  return `<svg viewBox="0 0 24 24" fill="currentColor">${inner}</svg>`;
}
const CATEGORY_ICONS = {
  "Fashion & Style": svgIcon('<path d="M20.6 3.5L16 2a4 4 0 01-8 0L3.4 3.5a2 2 0 00-1.3 2.2l.6 3.5a1 1 0 001 .8H6v10a2 2 0 002 2h8a2 2 0 002-2V10h2.3a1 1 0 001-.8l.6-3.5a2 2 0 00-1.3-2.2z"/>'),
  "Art & Design": svgIcon('<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>'),
  "Weddings": svgIcon('<path fill-rule="evenodd" d="M9 9a5.5 5.5 0 100 11 5.5 5.5 0 000-11zm0 2.2a3.3 3.3 0 110 6.6 3.3 3.3 0 010-6.6zM16 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zm0 2.2a3.3 3.3 0 110 6.6 3.3 3.3 0 010-6.6z"/>'),
  "Love": svgIcon('<path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 00-7.8 7.8l1.1 1.1L12 21.2l7.8-7.8 1.1-1.1a5.5 5.5 0 000-7.8z"/>'),
  "Travel": svgIcon('<path d="M22 2L2 9.6l7 3 2 7 2.5-5 5 4z"/>'),
  "Home & Decor": svgIcon('<path d="M12 2.7l9 7.1V20a1.3 1.3 0 01-1.3 1.3h-4.4v-7H8.7v7H4.3A1.3 1.3 0 013 20V9.8l9-7.1z"/>'),
  "Beauty & Skincare": svgIcon('<path d="M12 2s7 8.5 7 13a7 7 0 01-14 0c0-4.5 7-13 7-13z"/>'),
  "Pets & Animals": svgIcon('<circle cx="7" cy="7" r="1.7"/><circle cx="12" cy="4.8" r="1.7"/><circle cx="17" cy="7" r="1.7"/><circle cx="9.3" cy="10.8" r="1.7"/><path d="M12 11.5c-3.3 0-6 2.4-6 5s1.6 3.3 3.4 2.9c.9-.2 1.7-.6 2.6-.6s1.7.4 2.6.6c1.8.4 3.4-.3 3.4-2.9s-2.7-5-6-5z"/>'),
  "Quotes & Motivation": svgIcon('<path d="M7 7c-2.2 0-4 1.8-4 4v6h6v-6H7c0-1.1.9-2 2-2V7H7zm10 0c-2.2 0-4 1.8-4 4v6h6v-6h-2c0-1.1.9-2 2-2V7h-2z"/>'),
  "Food & Recipes": svgIcon('<path d="M18 8h1a4 4 0 010 8h-1.6a5.5 5.5 0 01-5.4 4H8a6 6 0 01-6-6V8a1 1 0 011-1h14a1 1 0 011 1zm0 2v4h1a2 2 0 000-4h-1z"/>'),
  "Comedy & Memes": svgIcon('<path d="M12 2a10 10 0 100 20 10 10 0 000-20zm-3.5 8a1.3 1.3 0 110 2.6 1.3 1.3 0 010-2.6zm7 0a1.3 1.3 0 110 2.6 1.3 1.3 0 010-2.6zM7.8 14.2a1 1 0 011.4-.1c.8.7 1.7 1 2.8 1s2-.3 2.8-1a1 1 0 111.3 1.5c-1.1.9-2.5 1.5-4.1 1.5s-3-.6-4.1-1.5a1 1 0 01-.1-1.4z"/>'),
  "Books & Reading": svgIcon('<path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2zm0 2A.5.5 0 006 4.5V17a2.5 2.5 0 011-.2h11V4H6.5z"/>'),
  "Movies & TV": svgIcon('<path d="M3 4h18a1 1 0 011 1v11a1 1 0 01-1 1h-6l2 3H7l2-3H3a1 1 0 01-1-1V5a1 1 0 011-1z"/>'),
  "DIY & Crafts": svgIcon('<path d="M8.5 2.5a2 2 0 00-2.8 0L2.5 5.7a2 2 0 000 2.8l1 1 6-6-1-1zM10.6 8.3l-6 6L13 22.7a2 2 0 002.8 0l3.2-3.2a2 2 0 000-2.8L10.6 8.3z"/>'),
  "Nature & Plants": svgIcon('<path d="M12 22V11c-4 0-7-3-7-7 5 0 7 2 7 6 0-4 2-6 7-6 0 4-3 7-7 7z"/>'),
  "Music": svgIcon('<path d="M9 18a3 3 0 11-2-2.8V5l12-2v10.2a3 3 0 11-2-2.8V6l-8 1.3V18z"/>'),
  "Fitness & Health": svgIcon('<rect x="1" y="9" width="5" height="7" rx="1.5"/><rect x="18" y="9" width="5" height="7" rx="1.5"/><rect x="6" y="11" width="12" height="3"/>'),
  "Business & Finance": svgIcon('<path d="M9 2a2 2 0 00-2 2v1H4a2 2 0 00-2 2v3h20V7a2 2 0 00-2-2h-3V4a2 2 0 00-2-2H9zm0 2h6v1H9V4zM2 12v7a2 2 0 002 2h16a2 2 0 002-2v-7H2z"/>'),
  "Tech & AI": svgIcon('<rect x="8" y="8" width="8" height="8" rx="1"/><rect x="10" y="1" width="4" height="4"/><rect x="10" y="19" width="4" height="4"/><rect x="1" y="10" width="4" height="4"/><rect x="19" y="10" width="4" height="4"/>'),
  "Uncategorized": svgIcon('<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>'),
};
const DEFAULT_CATEGORY_ICON = svgIcon('<path fill-rule="evenodd" d="M20.6 13.4L13.4 20.6a2 2 0 01-2.8 0L2 12V2h10l8.6 8.6a2 2 0 010 2.8zM8.5 8.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/>');
const ALL_ICON = svgIcon('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>');
function categoryIcon(cat){
  return CATEGORY_ICONS[cat] || DEFAULT_CATEGORY_ICON;
}

let autoPreviewEnabled = true;

// Instagram's official embed.js widget (blockquote -> iframe) turned out to
// be unreliable — it can get stuck at a tiny placeholder height indefinitely,
// independent of anything in this app (reproduced in complete isolation).
// A bare <iframe src=".../embed/"> pointed at the same URL works reliably
// and Instagram still sends the same resize handshake to it via
// postMessage, so we just listen for that ourselves instead of depending
// on their script to relay it — this also tells us the real height
// immediately, with no polling/guessing needed.
function loadPreview(id){
  const box = document.getElementById('pv-' + id);
  if(!box || box.dataset.loaded === '1') return;
  const p = postsById.get(id);
  if(!p) return;
  box.style.display = 'block';
  box.dataset.loaded = '1';
  const link = urlFor(p);

  const iframe = document.createElement('iframe');
  iframe.className = 'embed-frame';
  iframe.src = link + 'embed/';
  iframe.style.width = '326px';
  iframe.style.height = '600px'; // placeholder, replaced as soon as MEASURE arrives
  iframe.setAttribute('scrolling', 'no');
  iframe.title = 'Instagram post';
  box.innerHTML = '<div class="previewstatus">Loading preview…</div>';
  box.appendChild(iframe);

  let settled = false;
  const onMessage = (e) => {
    if(e.source !== iframe.contentWindow) return;
    let data;
    try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch(err){ return; }
    if(data && data.type === 'MEASURE' && data.details && typeof data.details.height === 'number'){
      if(!settled){
        settled = true;
        box.querySelector('.previewstatus')?.remove();
      }
      fitEmbedToSquare(box, iframe, data.details.height);
    }
  };
  window.addEventListener('message', onMessage);

  setTimeout(() => {
    if(!settled){
      window.removeEventListener('message', onMessage);
      box.innerHTML = '<div class="previewstatus">Could not load a live preview for this post. <a href="' + link + '" target="_blank" rel="noopener">Open on Instagram instead</a>.</div>';
    }
  }, 8000);
}

// Instagram's embed always renders the same chrome around the media —
// avatar/username/"View profile" on top, "View more on Instagram" + like/
// comment/share icons + likes count + comment box on the bottom — and we
// can't remove it (cross-origin content). These are best-effort constants
// from a real, visually-confirmed measurement of that chrome at the
// embed's natural width; Instagram could change its layout and throw
// these off, in which case the crop would drift by a similar amount.
const EMBED_HEADER_H = 88;
const EMBED_FOOTER_H = 155;

// Scales+positions the iframe itself (no wrapper needed) to crop out the
// header/footer chrome above and show just the media, filling the card's
// frame completely (cropping any excess) rather than letterboxing. Called
// every time Instagram reports a new height, and also whenever the frame
// itself resizes (density switcher, window resize).
function fitEmbedToSquare(box, iframe, naturalH){
  box.classList.add('fitted'); // now safe to clip — we have a real height
  if(typeof naturalH === 'number') iframe.dataset.naturalHeight = naturalH;
  const apply = () => {
    const nh = parseFloat(iframe.dataset.naturalHeight);
    const naturalW = 326;
    const frameW = box.clientWidth;
    const frameH = box.clientHeight;
    if(!frameW || !frameH || !nh) return;
    const mediaH = Math.max(nh - EMBED_HEADER_H - EMBED_FOOTER_H, 40);
    const scale = Math.max(frameW / naturalW, frameH / mediaH);
    const offsetX = (frameW - naturalW * scale) / 2;
    const offsetY = (frameH - mediaH * scale) / 2 - EMBED_HEADER_H * scale;
    iframe.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  };
  apply();
  if(window.ResizeObserver && !iframe.dataset.roAttached){
    iframe.dataset.roAttached = '1';
    new ResizeObserver(apply).observe(box);
  }
}

let previewObserver = null;
function setupAutoPreview(){
  if(previewObserver) previewObserver.disconnect();
  previewObserver = new IntersectionObserver((entries) => {
    if(!autoPreviewEnabled) return;
    for(const entry of entries){
      if(entry.isIntersecting){
        const id = entry.target.dataset.id;
        loadPreview(id);
      }
    }
  }, { rootMargin: '400px 0px', threshold: 0.01 });
  document.querySelectorAll('.card').forEach(card => previewObserver.observe(card));
}

document.getElementById('autoPreviewToggle').addEventListener('change', (e) => {
  autoPreviewEnabled = e.target.checked;
});

function escapeHtml(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Saturation/lightness for category badges (the pills on post cards,
// not the folder tiles — those are one uniform color, see
// tileStyle() below) live as CSS custom properties (css/style.css) so
// this stays in sync with the rest of the design system instead of
// carrying its own copy.
let catTokens = null;
function getCatTokens(){
  if(catTokens) return catTokens;
  const s = getComputedStyle(document.documentElement);
  catTokens = {
    sat: s.getPropertyValue('--cat-sat').trim() || '55%',
    bgLight: s.getPropertyValue('--cat-bg-light').trim() || '93%',
    inkSat: s.getPropertyValue('--cat-ink-sat').trim() || '45%',
    inkLight: s.getPropertyValue('--cat-ink-light').trim() || '28%',
  };
  return catTokens;
}
function hueFor(cat){
  let hash = 0;
  for(let i=0;i<cat.length;i++) hash = (hash*31 + cat.charCodeAt(i)) >>> 0;
  const hues = [355, 18, 32, 90, 145, 168, 200, 225, 265, 320];
  return hues[hash % hues.length];
}
function catStyle(cat){
  const h = hueFor(cat);
  const { sat, bgLight, inkSat, inkLight } = getCatTokens();
  return `background:hsl(${h} ${sat} ${bgLight}); color:hsl(${h} ${inkSat} ${inkLight});`;
}

// ---------- Folder tile palette ----------
// Extracted directly from the Figma source (node 24:197) via Dev Mode
// MCP — see js/app.js git history / conversation for the full report.
// Three stacked shapes, not one flat fill:
//   1. Union (tab+body, one fused outline) — vertical gradient
//      #F5E3B3 -> #C5A582, computed over ITS OWN bounding box
//      (199.667x181.943), reaching solid #C5A582 by ~34% down.
//   2. The "band" showing through the folder's opening — flat maroon
//      #8B1410, not white or red.
//   3. The front panel — the SAME #F5E3B3 -> #C5A582 gradient, but
//      computed over ITS OWN (smaller, lower) bounding box, so it
//      spans its full height and lands on the same #C5A582 at the
//      bottom. Two independently-computed gradients that happen to
//      converge on a matching color right at the handoff — that's
//      the actual "no visible seam" trick, not a single shared fill.
// Label/count text use the same maroon (#8B1410) as the band, not a
// near-black ink.
const TILE_GRAD_START = '#F5E3B3';
const TILE_GRAD_END = '#C5A582';
const TILE_BAND_COLOR = '#8B1410'; // the band peeking through the opening
const TILE_INK = '#8B1410';        // label/count/icon — same maroon as the band
function tileStyle(_cat){
  return `--tile-grad-start:${TILE_GRAD_START}; --tile-grad-end:${TILE_GRAD_END}; --tile-band-color:${TILE_BAND_COLOR}; --tile-ink:${TILE_INK};`;
}

// Three shapes in one SVG, each with the exact path data pulled from
// Figma (Union at 24:179, the band at 24:182, the front panel at
// 24:183) — this reproduces the real layer structure instead of
// approximating it with CSS boxes. viewBox matches Figma's own
// 199.667x181.943 artboard; preserveAspectRatio="none" stretches it
// to fill our (square) tile — Figma's artboard is very slightly
// wider than tall, a minor difference not worth breaking the grid's
// uniform square tiles over.
let folderSvgCounter = 0;
function folderSvg(){
  const id = 'fg' + (folderSvgCounter++);
  return `<svg class="folder-svg" viewBox="0 0 199.667 181.943" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="ug${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" style="stop-color:var(--tile-grad-start)"/>
        <stop offset="34.1346%" style="stop-color:var(--tile-grad-end)"/>
        <stop offset="100%" style="stop-color:var(--tile-grad-end)"/>
      </linearGradient>
      <linearGradient id="pg${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" style="stop-color:var(--tile-grad-start)"/>
        <stop offset="100%" style="stop-color:var(--tile-grad-end)"/>
      </linearGradient>
    </defs>
    <path d="M187.666 17C194.422 17 199.847 22.5754 199.662 29.3291L195.818 169.448C195.641 175.922 190.358 181.087 183.882 181.119L16.2344 181.942C9.71163 181.974 4.35752 176.79 4.17969 170.27L0 17V16C0 7.16344 7.16344 4.5098e-07 16 0H52.3613C57.3309 4.55417e-05 62.1781 1.54259 66.2334 4.41504L84 17H187.666Z" fill="url(#ug${id})" stroke="rgba(0,0,0,.12)" stroke-width="0.6"/>
    <g transform="translate(15,33)"><path d="M0.00208112 12.2211C-0.122564 5.45572 5.36795 -0.0747868 12.134 0.000764995L156.684 1.61485C163.347 1.68924 168.673 7.17708 168.548 13.8388L166.839 105.087C166.717 111.626 161.381 116.863 154.841 116.863H13.7109C7.16968 116.863 1.83348 111.624 1.71299 105.084L0.00208112 12.2211Z" fill="var(--tile-band-color)"/></g>
    <g transform="translate(2,58)">
      <!-- Two "papers" tucked behind the front panel, fully hidden at
           rest — they only slide up into view during the tap-open
           animation (see folder-paper-peek in style.css), like the
           papers peeking out of the folder in the Dribbble reference
           this was modeled on. Lighter tints from the SAME red family
           already used elsewhere in this app (the --sage-soft/
           --accent-soft rose/pink tokens), at different opacities,
           rather than actual white/cream paper. NOT --tile-band-color
           itself, even translucent: the papers slide up into the
           region that's already solid --tile-band-color underneath,
           and alpha-blending a color over an identical color is a
           no-op at any opacity — that first attempt was invisible,
           confirmed on screen (see the app's earlier same-hue
           translucency note re: the "All posts" bar for the same
           pitfall). Using genuinely lighter values keeps them visible
           against the dark band while staying in the same palette. -->
      <g class="folder-papers">
        <rect class="folder-paper folder-paper-1" x="22" y="34" width="152" height="58" rx="6" fill="var(--sage-soft)" fill-opacity="0.55"/>
        <rect class="folder-paper folder-paper-2" x="36" y="44" width="124" height="48" rx="6" fill="var(--accent-soft)" fill-opacity="0.85"/>
      </g>
      <!-- The front panel, hinged at its own bottom edge — on tap-open
           it tips back in 3D around that hinge (perspective + rotateX,
           see folder-flap-open in style.css) like a real folder cover
           lifting open, instead of squashing flat. An earlier version
           split this into two copies that skewed apart into a "V" —
           closer to the Dribbble reference's stylized cartoon effect,
           but it read as the flap vertically collapsing rather than a
           cover actually opening, so it's back to one hinged flap. -->
      <g class="folder-front"><path d="M0.00249174 12.2419C-0.133973 5.47325 5.3525 -0.0682669 12.1222 0.000635669L184.08 1.75084C190.774 1.81898 196.118 7.3522 195.954 14.0452L193.541 112.17C193.381 118.68 188.057 123.875 181.545 123.875H14.0136C7.4805 123.875 2.14778 118.648 2.0161 112.117L0.00249174 12.2419Z" fill="url(#pg${id})"/></g>
    </g>
  </svg>`;
}

// ---------- Category gallery screen ----------
// ---------- Category order (drag to reorder) ----------
const LS_CAT_ORDER = 'saved-organizer:category-order';
let categoryOrderOverride = null;
function loadCategoryOrder(){
  try{
    const raw = localStorage.getItem(LS_CAT_ORDER);
    if(raw) categoryOrderOverride = JSON.parse(raw);
  }catch(e){}
}
function saveCategoryOrder(orderedNames){
  categoryOrderOverride = orderedNames;
  try{ localStorage.setItem(LS_CAT_ORDER, JSON.stringify(orderedNames)); }catch(e){}
}
// All visible (non-locked) categories, in the user's custom order if
// they've dragged to reorder — anything new/unranked just falls in after,
// keeping its normal CATEGORY_ORDER position relative to other unranked ones.
function orderedVisibleCategories(){
  const cats = allCategories().filter(c => !LOCKED_CATEGORIES.includes(c));
  if(!categoryOrderOverride) return cats;
  const known = categoryOrderOverride.filter(c => cats.includes(c));
  const extra = cats.filter(c => !categoryOrderOverride.includes(c));
  return [...known, ...extra];
}

let reorderMode = false;

function renderGallery(){
  document.getElementById('stat-total').textContent = posts.length.toLocaleString();
  const cnt = counts();
  const visibleCatCount = orderedVisibleCategories().filter(c => cnt[c]).length;
  document.getElementById('stat-cats').textContent = visibleCatCount;

  // "All posts" is a plain flat bar, not a folder — it's the "everything"
  // escape hatch, not a category, so it shouldn't look like one. Never
  // draggable — it always stays first.
  let html = `<div class="allbar" data-cat="All">
    <div class="cattile-icon">${ALL_ICON}</div>
    <div class="cattile-label">All posts</div>
    <div class="cattile-count">${posts.length.toLocaleString()} posts</div>
  </div>`;

  for(const c of orderedVisibleCategories()){
    if(!cnt[c]) continue;
    html += `<div class="cattile${reorderMode ? ' reorderable' : ''}" data-cat="${escapeHtml(c)}" style="${tileStyle(c)}">
      ${folderSvg()}
      <div class="folder-body">
        <div class="cattile-icon-chip"><div class="cattile-icon">${categoryIcon(c)}</div></div>
        <div class="cattile-bottom">
          <div class="cattile-label">${escapeHtml(c)}</div>
          <div class="cattile-count">${cnt[c].toLocaleString()} posts</div>
        </div>
      </div>
    </div>`;
  }
  document.getElementById('catgrid').innerHTML = html;

  // Every folder tile can start a long-press-to-reorder gesture, and (once
  // reorder mode is on) can also be picked up and dragged immediately.
  // "All posts" is never draggable and is inert while reordering — tapping
  // it then just falls through to the outside-tap-exits handler below.
  document.querySelectorAll('.cattile').forEach(el => {
    el.addEventListener('pointerdown', onTilePointerDown);
  });
  if(!reorderMode){
    document.getElementById('catgrid').querySelectorAll('.allbar').forEach(el => {
      el.addEventListener('click', () => openCategory(el.dataset.cat));
    });
  }
}

// Renders the ancestor trail above a screen's own big heading — e.g. just
// "Saved", or "Saved › Travel" — each segment clickable to jump back to
// that level. The current screen's own title is NOT one of these segments;
// that's the big <h2> shown below the trail.
function renderBreadcrumb(containerId, segments){
  const el = document.getElementById(containerId);
  const sepSvg = '<svg class="crumb-sep" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
  el.innerHTML = segments.map((seg, i) =>
    `${i > 0 ? sepSvg : ''}<button type="button" class="crumb" data-i="${i}">${escapeHtml(seg.label)}</button>`
  ).join('');
  el.querySelectorAll('.crumb').forEach((btn, i) => {
    btn.addEventListener('click', segments[i].onClick);
  });
}
const toGalleryCrumb = { label: 'Saved', onClick: () => { renderGallery(); showScreen('gallery'); } };

// Sets up and shows the detail screen for one category (optionally scoped
// to a sub-category), remembering where "back" should return to.
function enterDetail(cat, subcatLabel, from){
  activeCat = cat;
  activeSubcat = subcatLabel || null;
  cameFrom = from;
  query = '';
  document.getElementById('search').value = '';
  visibleCount = PAGE;
  document.getElementById('detailTitle').textContent =
    cat === 'All' ? 'All posts' : (subcatLabel ? `${cat} — ${subcatLabel}` : cat);
  renderBreadcrumb('detailBreadcrumb',
    from === 'subgallery' ? [toGalleryCrumb, { label: cat, onClick: () => showCategorySubgallery(cat) }] :
    from === 'vault' ? [toGalleryCrumb, { label: 'Locked', onClick: () => openVault() }] :
    [toGalleryCrumb]
  );
  showScreen('detail');
  render();
}

// Tapping a gallery tile: routes to the vault gate, a places/sub-category
// gallery, or straight to the post list — whichever applies.
function openCategory(cat){
  if(LOCKED_CATEGORIES.includes(cat)){ openVault(); return; }
  const subs = subcategoriesFor(cat);
  if(subs.length > 0){ showCategorySubgallery(cat); return; }
  enterDetail(cat, null, 'gallery');
}

// ---------- Sub-galleries (category places, and the vault's contents) ----------
let subgalleryContext = null; // {type:'category', cat} | {type:'vault'}

function showCategorySubgallery(cat){
  subgalleryContext = { type: 'category', cat };
  document.getElementById('subgalleryTitle').textContent = cat;
  renderBreadcrumb('subgalleryBreadcrumb', [toGalleryCrumb]);
  renderSubgallery();
  showScreen('subgallery');
}
function showSubgalleryForVault(){
  subgalleryContext = { type: 'vault' };
  document.getElementById('subgalleryTitle').textContent = 'Locked';
  renderBreadcrumb('subgalleryBreadcrumb', [toGalleryCrumb]);
  renderSubgallery();
  showScreen('subgallery');
}

function renderSubgallery(){
  const grid = document.getElementById('subgrid');
  if(subgalleryContext.type === 'vault'){
    grid.className = 'catgrid';
    const cnt = counts();
    let html = '';
    for(const cat of LOCKED_CATEGORIES){
      if(!cnt[cat]) continue;
      html += `<div class="cattile" data-cat="${escapeHtml(cat)}" style="${tileStyle(cat)}">
        ${folderSvg()}
        <div class="folder-body">
          <div class="cattile-icon-chip"><div class="cattile-icon">${categoryIcon(cat)}</div></div>
          <div class="cattile-bottom">
            <div class="cattile-label">${escapeHtml(cat)}</div>
            <div class="cattile-count">${cnt[cat].toLocaleString()} posts</div>
          </div>
        </div>
      </div>`;
    }
    grid.innerHTML = html;
    grid.querySelectorAll('.cattile').forEach(el => {
      el.addEventListener('click', () => animateTileOpenThenNavigate(el, () => enterDetail(el.dataset.cat, null, 'vault')));
    });
  } else {
    // Indented list, not cards: the category itself as the flush-left
    // root row, each sub-category below it nested under a hooked arrow.
    const cat = subgalleryContext.cat;
    const subs = subcategoriesFor(cat);
    const total = posts.filter(p => p.category === cat).length;
    const cornerArrow = '<svg class="sublist-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>';
    const chevron = '<svg class="sublist-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';
    let html = `<div class="sublist-row" data-subcat="" style="${tileStyle(cat)}">
      <div class="sublist-iconlabel">
        <div class="sublist-icon">${folderSvg()}</div>
        <div class="sublist-label">${escapeHtml(cat)}</div>
      </div>
      <div class="sublist-count">${total.toLocaleString()}</div>
      ${chevron}
    </div>`;
    for(const s of subs){
      html += `<div class="sublist-row sublist-row--sub" data-subcat="${escapeHtml(s.label)}" style="${tileStyle(s.label)}">
        ${cornerArrow}
        <div class="sublist-iconlabel">
          <div class="sublist-icon">${folderSvg()}</div>
          <div class="sublist-label">${escapeHtml(s.label)}</div>
        </div>
        <div class="sublist-count">${s.count.toLocaleString()}</div>
        ${chevron}
      </div>`;
    }
    grid.className = 'catgrid sublist';
    grid.innerHTML = html;
    grid.querySelectorAll('.sublist-row').forEach(el => {
      el.addEventListener('click', () => enterDetail(cat, el.dataset.subcat || null, 'subgallery'));
    });
  }
}

document.getElementById('backFromSubgallery').addEventListener('click', () => {
  renderGallery();
  showScreen('gallery');
});

document.getElementById('backToGallery').addEventListener('click', () => {
  if(cameFrom === 'subgallery'){ showCategorySubgallery(activeCat); return; }
  if(cameFrom === 'vault'){ openVault(); return; } // password required again, no exceptions
  renderGallery();
  showScreen('gallery');
});

// ---------- Vault (locked folder) ----------
// No "stays unlocked for the session" — the password is required every
// single time the vault is entered, with no exceptions (including coming
// back to it via the detail screen's own back button).
let vaultMode = 'enter'; // 'set' | 'enter'
function openVault(){
  const stored = localStorage.getItem(VAULT_HASH_KEY);
  openVaultModal(stored ? 'enter' : 'set');
}
function openVaultModal(mode){
  vaultMode = mode;
  document.getElementById('vaultTitle').textContent = mode === 'set' ? 'Set a password' : 'Enter password';
  const note = document.getElementById('vaultNote');
  note.hidden = mode !== 'set';
  note.textContent = "This only keeps it out of casual view — it's not real security. Anyone with access to the files on this Mac could still read the data directly.";
  document.getElementById('vaultPasswordConfirm').style.display = mode === 'set' ? 'block' : 'none';
  document.getElementById('vaultPassword').value = '';
  document.getElementById('vaultPasswordConfirm').value = '';
  document.getElementById('vaultError').hidden = true;
  const forgot = document.getElementById('vaultForgot');
  forgot.hidden = mode !== 'enter';
  forgot.textContent = 'Forgot password?';
  forgotArmed = false;
  document.getElementById('vaultBackdrop').classList.add('open');
  document.getElementById('vaultPassword').focus();
}
function closeVaultModal(){
  document.getElementById('vaultBackdrop').classList.remove('open');
}
function showVaultError(msg){
  const el = document.getElementById('vaultError');
  el.textContent = msg;
  el.hidden = false;
}
document.getElementById('vaultCancel').addEventListener('click', closeVaultModal);
document.getElementById('vaultBackdrop').addEventListener('click', (e) => {
  if(e.target.id === 'vaultBackdrop') closeVaultModal();
});
// Forgotten passwords can't be recovered (only a hash is stored, and we
// never see the original text) — only reset. Requires tapping twice so
// it's not triggered by accident.
let forgotArmed = false;
document.getElementById('vaultForgot').addEventListener('click', () => {
  const btn = document.getElementById('vaultForgot');
  if(!forgotArmed){
    forgotArmed = true;
    btn.textContent = 'Tap again to reset — you’ll set a new one (nothing else is affected)';
    return;
  }
  localStorage.removeItem(VAULT_HASH_KEY);
  openVaultModal('set');
});
function submitVault(){
  const pw = document.getElementById('vaultPassword').value;
  if(!pw){ showVaultError('Enter a password.'); return; }
  if(vaultMode === 'set'){
    const confirmPw = document.getElementById('vaultPasswordConfirm').value;
    if(pw !== confirmPw){ showVaultError("Passwords don't match."); return; }
    localStorage.setItem(VAULT_HASH_KEY, simpleHash(pw));
    closeVaultModal();
    showSubgalleryForVault();
  } else {
    const stored = localStorage.getItem(VAULT_HASH_KEY);
    if(simpleHash(pw) === stored){
      closeVaultModal();
      showSubgalleryForVault();
    } else {
      showVaultError('Wrong password.');
    }
  }
}
document.getElementById('vaultSubmit').addEventListener('click', submitVault);
[document.getElementById('vaultPassword'), document.getElementById('vaultPasswordConfirm')].forEach(el => {
  el.addEventListener('keydown', (e) => { if(e.key === 'Enter') submitVault(); });
});

const COLUMN_CLASS = { list: 'cols-1', two: 'cols-2', grid: 'cols-grid' };
document.querySelectorAll('.viewbtn').forEach(btn => {
  btn.addEventListener('click', () => {
    columnMode = btn.dataset.cols;
    document.querySelectorAll('.viewbtn').forEach(b => b.classList.toggle('active', b.dataset.cols === columnMode));
    const feed = document.getElementById('feed');
    feed.classList.remove('cols-1', 'cols-2', 'cols-grid');
    feed.classList.add(COLUMN_CLASS[columnMode]);
  });
});

// ---------- Post cards (detail screen) ----------
function renderCard(p){
  const colls = p.collections.slice(0,3).map(c => `<span class="collchip">${escapeHtml(c)}</span>`).join('');
  const selected = selectedIds.has(p.id);
  const checkbox = triageMode
    ? `<input type="checkbox" class="card-select" data-action="select" ${selected ? 'checked' : ''} aria-label="Select post" />`
    : '';
  return `
  <div class="card ${triageMode ? 'selectable' : ''} ${selected ? 'selected' : ''}" data-id="${p.id}">
    ${checkbox}
    <div class="card-bottom">
      <div class="catrow">
        <span class="catpill" style="${catStyle(p.category)}" data-action="cat">${escapeHtml(p.category)}</span>
        ${colls ? `<div class="collchips">${colls}</div>` : ''}
      </div>
      <a class="openlink" href="${urlFor(p)}" target="_blank" rel="noopener" title="Open on Instagram" aria-label="Open on Instagram">${EXTERNAL_ICON}</a>
    </div>
    <div class="previewbox" id="pv-${p.id}" style="display:none;" data-id="${p.id}"></div>
  </div>`;
}

function render(){
  document.getElementById('detailCount').textContent = `${filtered().length.toLocaleString()} posts`;

  const list = filtered();
  const slice = list.slice(0, visibleCount);
  const feed = document.getElementById('feed');
  if(slice.length === 0){
    feed.innerHTML = `<div class="empty">No saved posts match this view.</div>`;
  } else {
    feed.innerHTML = slice.map(renderCard).join('');
  }

  document.querySelectorAll('.catpill').forEach(el => {
    el.addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      openCatSheet(card.dataset.id);
    });
  });
  document.querySelectorAll('[data-action="select"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = e.target.closest('.card');
      toggleSelect(card.dataset.id);
    });
  });
  if(triageMode){
    document.querySelectorAll('.card').forEach(card => {
      card.addEventListener('click', (e) => {
        if(e.target.closest('[data-action]') || e.target.closest('a')) return;
        toggleSelect(card.dataset.id);
      });
    });
  }

  const loadBtn = document.getElementById('loadmore');
  loadBtn.style.display = list.length > visibleCount ? 'block' : 'none';
  setupAutoPreview();
  renderTriageBar();
}

function toggleSelect(id){
  if(selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
  render();
}

function renderTriageBar(){
  const bar = document.getElementById('triagebar');
  if(!triageMode){ bar.hidden = true; return; }
  bar.hidden = false;
  const list = filtered();
  document.getElementById('triageCount').textContent = `${selectedIds.size.toLocaleString()} selected`;
  const selectAllBtn = document.getElementById('selectAllBtn');
  const allSelected = list.length > 0 && list.every(p => selectedIds.has(p.id));
  selectAllBtn.textContent = allSelected ? 'Deselect all' : `Select all ${list.length.toLocaleString()} matching`;
  document.getElementById('bulkMoveBtn').disabled = selectedIds.size === 0;
}

// subcat: '' means "no subcategory, sits directly under the category";
// omit the argument (undefined) to leave whatever subcategory the post(s)
// already had alone (used when reassigning only the main category isn't
// meant to touch subcategory — currently unused by the sheet UI below,
// which always passes one explicitly, but kept as the safe default).
function bulkAssignCategoryAndSubcat(ids, cat, subcat){
  for(const id of ids){
    const p = postsById.get(id);
    if(!p) continue;
    p.category = cat;
    overrides[id] = cat;
    if(subcat !== undefined) subcatOverrides[id] = subcat;
  }
  persist();
  render();
}

document.getElementById('loadmore').addEventListener('click', () => {
  visibleCount += PAGE;
  render();
});

let searchDebounce = null;
document.getElementById('search').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const v = e.target.value;
  searchDebounce = setTimeout(() => {
    query = v;
    visibleCount = PAGE;
    render();
  }, 200);
});

// The move sheet is two "screens" sharing one modal: a flat list of main
// categories (sheetView 'categories'), or — after tapping a category's
// own drill-in arrow — that category's subcategories (sheetView
// 'subcats', sheetDrillCat holds which one). Tapping a category's own
// label (not its arrow) still assigns straight to it with no
// subcategory, exactly like before this sheet knew about subcategories
// at all; the arrow is the only new thing on that screen.
let activePostId = null;
let bulkAssignActive = false;
let sheetView = 'categories';
let sheetDrillCat = null;

function openCatSheet(id, bulk){
  bulkAssignActive = !!bulk;
  activePostId = bulk ? null : id;
  sheetView = 'categories';
  sheetDrillCat = null;
  renderSheetOptions();
  document.getElementById('sheetBackdrop').classList.add('open');
}

function renderSheetOptions(){
  const backBtn = document.getElementById('sheetBackBtn');
  const newCatRow = document.getElementById('sheetNewCat');
  const newSubcatRow = document.getElementById('sheetNewSubcat');
  const countLabel = bulkAssignActive ? `${selectedIds.size.toLocaleString()} posts` : '1 post';

  if(sheetView === 'categories'){
    backBtn.hidden = true;
    newCatRow.hidden = false;
    newSubcatRow.hidden = true;
    document.getElementById('sheetTitle').textContent = `Move ${countLabel} to category`;

    const cats = allCategories();
    const cnt = counts();
    document.getElementById('sheetOptions').innerHTML = cats.map(c => `
      <div class="sheet-opt" data-cat="${escapeHtml(c)}">
        <span class="sheet-opt-main" data-action="assign">
          <span class="sheet-opt-label">${escapeHtml(c)}</span>
          <span class="n">${cnt[c]||0}</span>
        </span>
        <button type="button" class="sheet-opt-drill" data-action="drill" aria-label="View ${escapeHtml(c)} subcategories">›</button>
      </div>`).join('');
    document.querySelectorAll('.sheet-opt').forEach(el => {
      const cat = el.dataset.cat;
      el.querySelector('[data-action="assign"]').addEventListener('click', () => {
        commitMove(cat, '');
      });
      el.querySelector('[data-action="drill"]').addEventListener('click', () => {
        sheetView = 'subcats';
        sheetDrillCat = cat;
        renderSheetOptions();
      });
    });
  } else {
    const cat = sheetDrillCat;
    backBtn.hidden = false;
    newCatRow.hidden = true;
    newSubcatRow.hidden = false;
    document.getElementById('sheetTitle').textContent = `Move ${countLabel} to a ${escapeHtml(cat)} subcategory`;

    const subs = subcategoriesFor(cat, true);
    let html = `<div class="sheet-opt sheet-opt-allcat" data-subcat="">
      <span class="sheet-opt-label">All ${escapeHtml(cat)} <span class="sheet-opt-hint">(no subcategory)</span></span>
    </div>`;
    html += subs.map(s => `
      <div class="sheet-opt" data-subcat="${escapeHtml(s.label)}">
        <span class="sheet-opt-label">${escapeHtml(s.label)}</span>
        <span class="n">${s.count.toLocaleString()}</span>
      </div>`).join('');
    document.getElementById('sheetOptions').innerHTML = html;
    document.querySelectorAll('.sheet-opt').forEach(el => {
      el.addEventListener('click', () => commitMove(cat, el.dataset.subcat));
    });
  }
}

document.getElementById('sheetBackBtn').addEventListener('click', () => {
  sheetView = 'categories';
  sheetDrillCat = null;
  renderSheetOptions();
});

// The one place that actually performs a move, regardless of whether it
// came from picking an existing category/subcategory or typing a new
// one — keeps bulk-vs-single and the sheet-closing/persist steps in
// exactly one spot instead of repeated at every call site.
function commitMove(cat, subcat){
  if(bulkAssignActive){
    const ids = [...selectedIds];
    selectedIds.clear();
    bulkAssignCategoryAndSubcat(ids, cat, subcat);
  } else {
    assignCategoryAndSubcat(activePostId, cat, subcat);
  }
  closeSheet();
}

function closeSheet(){
  document.getElementById('sheetBackdrop').classList.remove('open');
  document.getElementById('newCatInput').value = '';
  document.getElementById('newSubcatInput').value = '';
  bulkAssignActive = false;
  sheetView = 'categories';
  sheetDrillCat = null;
}
document.getElementById('sheetClose').addEventListener('click', closeSheet);
document.getElementById('sheetBackdrop').addEventListener('click', (e) => {
  if(e.target.id === 'sheetBackdrop') closeSheet();
});
document.getElementById('newCatBtn').addEventListener('click', () => {
  const v = document.getElementById('newCatInput').value.trim();
  if(!v) return;
  if(!customCategories.includes(v)) customCategories.push(v);
  commitMove(v, '');
  persist();
});
document.getElementById('newSubcatBtn').addEventListener('click', () => {
  const v = document.getElementById('newSubcatInput').value.trim();
  if(!v || !sheetDrillCat) return;
  const cat = sheetDrillCat;
  if(!customSubcats[cat]) customSubcats[cat] = [];
  if(!customSubcats[cat].includes(v)) customSubcats[cat].push(v);
  commitMove(cat, v);
  persist();
});

function assignCategoryAndSubcat(id, cat, subcat){
  const p = postsById.get(id);
  if(!p) return;
  p.category = cat;
  overrides[id] = cat;
  if(subcat !== undefined) subcatOverrides[id] = subcat;
  persist();
  render();
}

document.getElementById('triageToggle').addEventListener('click', () => {
  triageMode = !triageMode;
  if(!triageMode) selectedIds.clear();
  document.body.classList.toggle('triage-active', triageMode);
  const btn = document.getElementById('triageToggle');
  btn.textContent = triageMode ? 'Exit selection' : 'Select multiple';
  btn.classList.toggle('active', triageMode);
  render();
});
document.getElementById('selectAllBtn').addEventListener('click', () => {
  const list = filtered();
  const allSelected = list.length > 0 && list.every(p => selectedIds.has(p.id));
  if(allSelected){
    for(const p of list) selectedIds.delete(p.id);
  } else {
    for(const p of list) selectedIds.add(p.id);
  }
  render();
});
document.getElementById('clearSelBtn').addEventListener('click', () => {
  selectedIds.clear();
  render();
});
document.getElementById('bulkMoveBtn').addEventListener('click', () => {
  if(selectedIds.size === 0) return;
  openCatSheet(null, true);
});

// ---------- Reorder mode (long-press any folder to drag-reorder them all) ----------
// No visible toggle: holding down on any tile puts every tile into "jiggle"
// mode and picks that one up to drag right away (like iOS home-screen
// icons). Tapping anywhere that isn't a tile — the topbar, "All posts",
// empty grid space — exits reorder mode again.
function exitReorderMode(){
  if(!reorderMode) return;
  reorderMode = false;
  renderGallery();
}
document.getElementById('screen-gallery').addEventListener('click', (e) => {
  if(!reorderMode) return;
  if(e.target.closest('.cattile')) return; // tile taps are handled by the drag logic, not this
  exitReorderMode();
});

// A tile "pops open" (panel swings up, tile scales in) before the
// actual screen change — purely cosmetic, so navigation is just
// delayed by the animation's own duration rather than depending on it
// (if the tile element ever isn't found, we navigate immediately).
const TILE_OPEN_ANIM_MS = 380; // matches folder-open-tile's duration in style.css
function animateTileOpenThenNavigate(tileEl, navigate){
  if(!tileEl){ navigate(); return; }
  tileEl.classList.add('opening');
  setTimeout(navigate, TILE_OPEN_ANIM_MS);
}

const TILE_LONG_PRESS_MS = 500, TILE_MOVE_TOLERANCE = 10;
function onTilePointerDown(e){
  if(reorderMode){ onTileDragStart(e); return; }

  const cat = e.currentTarget.dataset.cat;
  const tileEl = e.currentTarget;
  const startX = e.clientX, startY = e.clientY;
  let longPressed = false;

  const timer = setTimeout(() => {
    longPressed = true;
    cleanup();
    reorderMode = true;
    renderGallery();
    // Pick the freshly-rendered tile back up and start dragging it
    // immediately, since the finger/pointer never actually left it.
    const freshTile = [...document.querySelectorAll('.cattile')].find(t => t.dataset.cat === cat);
    if(freshTile) onTileDragStart({ currentTarget: freshTile, clientX: startX, clientY: startY, preventDefault(){} });
  }, TILE_LONG_PRESS_MS);

  function onMove(ev){
    if(Math.hypot(ev.clientX - startX, ev.clientY - startY) > TILE_MOVE_TOLERANCE) cleanup();
  }
  function onUp(){
    cleanup();
    if(!longPressed) animateTileOpenThenNavigate(tileEl, () => openCategory(cat));
  }
  function cleanup(){
    clearTimeout(timer);
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}

let dragEl = null, dragGhost = null, dragOffsetX = 0, dragOffsetY = 0;
function onTileDragStart(e){
  if(!reorderMode) return;
  e.preventDefault();
  dragEl = e.currentTarget;
  const rect = dragEl.getBoundingClientRect();
  dragOffsetX = e.clientX - rect.left;
  dragOffsetY = e.clientY - rect.top;

  dragGhost = dragEl.cloneNode(true);
  dragGhost.className = 'cattile cattile-ghost';
  dragGhost.style.width = rect.width + 'px';
  dragGhost.style.height = rect.height + 'px';
  dragGhost.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
  document.body.appendChild(dragGhost);

  dragEl.classList.add('dragging');
  document.addEventListener('pointermove', onTileDragMove);
  document.addEventListener('pointerup', onTileDragEnd);
  document.addEventListener('pointercancel', onTileDragEnd);
}
function onTileDragMove(e){
  if(!dragEl) return;
  dragGhost.style.transform = `translate(${e.clientX - dragOffsetX}px, ${e.clientY - dragOffsetY}px)`;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const targetTile = under ? under.closest('.cattile.reorderable') : null;
  if(targetTile && targetTile !== dragEl){
    const grid = document.getElementById('catgrid');
    const tiles = [...grid.querySelectorAll('.cattile.reorderable')];
    const dragIndex = tiles.indexOf(dragEl);
    const targetIndex = tiles.indexOf(targetTile);
    if(dragIndex < targetIndex) targetTile.after(dragEl);
    else targetTile.before(dragEl);
  }
}
function onTileDragEnd(){
  if(!dragEl) return;
  dragEl.classList.remove('dragging');
  dragGhost.remove();
  dragGhost = null;
  document.removeEventListener('pointermove', onTileDragMove);
  document.removeEventListener('pointerup', onTileDragEnd);
  document.removeEventListener('pointercancel', onTileDragEnd);
  const order = [...document.querySelectorAll('.cattile.reorderable')].map(el => el.dataset.cat);
  saveCategoryOrder(order);
  dragEl = null;
}

// ---------- Hidden vault entry ----------
// The locked folder has no visible tile — long-press the "Saved." brand
// to open it. Deliberately not documented anywhere in the UI.
(function setupVaultTrigger(){
  const el = document.getElementById('brandTrigger');
  let timer = null, startX = 0, startY = 0;
  const LONG_PRESS_MS = 650, MOVE_TOLERANCE = 12;
  // On touch devices, holding down on text normally triggers text selection
  // or a native context menu (Android) — either one swallows our gesture
  // before the timer fires. Suppress both explicitly.
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startX = e.clientX; startY = e.clientY;
    timer = setTimeout(() => { timer = null; openVault(); }, LONG_PRESS_MS);
  });
  const cancel = (e) => {
    if(e && e.clientX != null){
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if(Math.hypot(dx, dy) < MOVE_TOLERANCE && timer === null) return; // already fired, let it be
    }
    if(timer){ clearTimeout(timer); timer = null; }
  };
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointermove', (e) => {
    if(!timer) return;
    if(Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_TOLERANCE){
      clearTimeout(timer); timer = null;
    }
  });
})();

// ---------- "Last synced" indicator ----------
// Instagram has no API for pulling your saved posts, so this app can't
// sync itself — DATA_SYNCED_AT (js/sync-meta.js) is stamped by
// tools/import_saved_posts.py every time you run it, including when
// there's nothing new, so this reads as "last time you checked,"
// not just "last time content actually changed."
function updateSyncStatus(){
  const el = document.getElementById('syncStat');
  if(!el) return;
  if(typeof DATA_SYNCED_AT === 'undefined'){
    el.textContent = 'Never synced from Instagram';
    return;
  }
  const then = new Date(DATA_SYNCED_AT);
  if(isNaN(then)){ el.textContent = ''; return; }
  const days = Math.floor((Date.now() - then) / 86400000);
  let rel;
  if(days <= 0) rel = 'today';
  else if(days === 1) rel = 'yesterday';
  else if(days < 30) rel = `${days} days ago`;
  else if(days < 365){ const m = Math.floor(days / 30); rel = `${m} month${m > 1 ? 's' : ''} ago`; }
  else { const y = Math.floor(days / 365); rel = `${y} year${y > 1 ? 's' : ''} ago`; }
  el.textContent = `Synced ${rel}`;
  el.title = then.toLocaleString();
}

// ---------- Boot ----------
loadCategoryOrder();
loadStorage();
updateSyncStatus();

const SPLASH_DURATION = 2000;
function enterGallery(){
  showScreen('gallery');
  renderGallery();
}
const splashTimer = setTimeout(enterGallery, SPLASH_DURATION);
document.getElementById('screen-splash').addEventListener('click', () => {
  clearTimeout(splashTimer);
  enterGallery();
});
