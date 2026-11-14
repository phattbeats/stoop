/**
 * Stoop — phone-first shell.
 *
 * Server-rendered, one column, no build step. Emily's phone is the only
 * viewport that matters: big targets, one action per screen, and nothing
 * that needs a mouse.
 */

export interface PendingDraft {
  id: string;
  title: string;
  priceRange: { lowCents: number; highCents: number };
  tags: string[];
  shipping: { label: string; priceCents: number }[];
  flags: string[];
  confidence: number;
  notes: string;
}

export interface TodayItem {
  id: string;
  title: string;
  priceCents: number;
  status: string;
  photos: string[];
  sold: boolean;
  listings: { marketplace: string; state: string }[];
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderShell(options: {
  displayName: string;
  items: TodayItem[];
  /** Drafts waiting on Emily. The model proposed; she decides. */
  drafts?: PendingDraft[];
}): string {
  const { displayName, items, drafts = [] } = options;

  const draftCards = drafts
    .map((draft) => {
      const price = `${money(draft.priceRange.lowCents)} – ${money(draft.priceRange.highCents)}`;
      const tags = draft.tags.length ? draft.tags.join(' · ') : '';
      const shipping = draft.shipping
        .map((option) => `${option.label} ${money(option.priceCents)}`)
        .join(', ');
      const flags = draft.flags.length ? draft.flags.join(' · ') : '';
      return `
      <li class="draft">
        <p class="title">${escapeHtml(draft.title)}</p>
        <p class="price">${price}</p>
        ${tags ? `<p class="meta-line">${escapeHtml(tags)}</p>` : ''}
        ${shipping ? `<p class="meta-line">${escapeHtml(shipping)}</p>` : ''}
        ${flags ? `<p class="meta-line flags">${escapeHtml(flags)}</p>` : ''}
        <div class="row">
          <button class="approve" data-draft="${escapeHtml(draft.id)}">Approve</button>
          <button class="reject" data-draft="${escapeHtml(draft.id)}">No</button>
        </div>
      </li>`;
    })
    .join('\n');

  const rows = items
    .map((item) => {
      const live = item.listings.filter((l) => l.state === 'live').map((l) => l.marketplace);
      const badges = live.length
        ? live.map((m) => `<span class="badge">${escapeHtml(m)}</span>`).join('')
        : '<span class="badge dim">not published</span>';
      const photo = item.photos[0]
        ? `<img src="${escapeHtml(item.photos[0])}" alt="">`
        : '<div class="ph"></div>';
      const sold = item.sold ? '<span class="badge sold">sold</span>' : '';
      return `
      <li class="item">
        <div class="thumb">${photo}</div>
        <div class="meta">
          <p class="title">${escapeHtml(item.title)}</p>
          <p class="price">${money(item.priceCents)} ${badges} ${sold}</p>
        </div>
      </li>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Stoop</title>
<style>
  :root { color-scheme: dark; --bg:#0d0f12; --card:#161a20; --ink:#e8eaed; --dim:#8b949e; --accent:#7ee787; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font: 16px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         padding: 0 0 env(safe-area-inset-bottom); }
  header { padding: 22px 18px 12px; }
  h1 { margin:0; font-size: 26px; letter-spacing:.3px; }
  header p { margin: 4px 0 0; color: var(--dim); font-size: 14px; }
  ul { list-style:none; margin: 0; padding: 8px 12px 24px; }
  .item { display:flex; gap:12px; align-items:center; background:var(--card);
          border-radius:14px; padding:12px; margin-bottom:10px; }
  .thumb { width:64px; height:64px; flex:0 0 64px; border-radius:10px; overflow:hidden;
           background:#22272e; display:flex; align-items:center; justify-content:center; }
  .thumb img { width:100%; height:100%; object-fit:cover; }
  .meta { min-width:0; }
  .title { margin:0 0 4px; font-weight:600; }
  .price { margin:0; color:var(--dim); font-size:14px; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px;
           background:#1f6feb33; color:#79c0ff; margin-left:6px; }
  .badge.dim { background:#21262d; color:var(--dim); }
  .badge.sold { background:#7ee78722; color:var(--accent); }
  .empty { color:var(--dim); text-align:center; padding:48px 18px; }
  section.drafts { margin: 4px 12px 18px; }
  section.drafts h2 { font-size: 17px; margin: 10px 4px 6px; color: var(--dim);
                      text-transform: uppercase; letter-spacing:.6px; }
  section.drafts ul { list-style:none; margin:0; padding:0; }
  li.draft { background: var(--card); border-radius:14px; padding:12px; margin-bottom:10px;
             border-left:3px solid var(--accent); }
  .meta-line { margin:4px 0 0; color: var(--dim); font-size:14px; }
  .meta-line.flags { color: #d29922; }
  .row { display:flex; gap:10px; margin-top:12px; }
  .row button { margin-top:0; flex:1; }
  button.reject { background:#21262d; color:var(--ink); }
  textarea { width:100%; padding:12px; border-radius:10px; border:1px solid #30363d;
             background:#0d1117; color:var(--ink); font-size:16px; font-family:inherit; }
  input[type=file] { padding:10px; }
  form { margin: 0 12px 24px; background:var(--card); border-radius:14px; padding:14px; }
  label { display:block; font-size:13px; color:var(--dim); margin:10px 0 4px; }
  input { width:100%; padding:12px; border-radius:10px; border:1px solid #30363d;
          background:#0d1117; color:var(--ink); font-size:16px; }
  button { width:100%; margin-top:14px; padding:14px; border:0; border-radius:12px;
           background:var(--accent); color:#06210d; font-size:16px; font-weight:600; }
  .msg { margin-top:10px; font-size:14px; color:var(--dim); }
</style>
</head>
<body>
<header>
  <h1>Stoop</h1>
  <p>${escapeHtml(displayName)} — ${items.length} item${items.length === 1 ? '' : 's'}</p>
</header>
<ul>
${rows || '<li class="empty">Nothing here yet. Photograph something.</li>'}
</ul>
${
  draftCards
    ? `<section class="drafts"><h2>Waiting on you</h2><ul>${draftCards}</ul></section>`
    : ''
}
<form id="snap" autocomplete="off" enctype="multipart/form-data">
  <label for="photo">Photograph it</label>
  <input id="photo" name="photo" type="file" accept="image/*" capture="environment">
  <label for="snapnotes">Anything to add? (voice note, size, price in mind)</label>
  <textarea id="snapnotes" name="notes" rows="3" placeholder="Small print, framed, about $20"></textarea>
  <button type="submit">Draft the listing</button>
  <p class="msg" id="snapmsg"></p>
</form>
<form id="capture" autocomplete="off">
  <label for="title">What is it?</label>
  <input id="title" name="title" placeholder="Print no. 3" required>
  <label for="price">Price (cents)</label>
  <input id="price" name="priceCents" inputmode="numeric" placeholder="3500" required>
  <button type="submit">Add item</button>
  <p class="msg" id="msg"></p>
</form>
<script>
  const decide = async (id, action) => {
    const res = await fetch('/api/drafts/' + id + '/' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.ok) location.reload();
  };
  document.querySelectorAll('button.approve').forEach((btn) => {
    btn.addEventListener('click', () => decide(btn.dataset.draft, 'approve'));
  });
  document.querySelectorAll('button.reject').forEach((btn) => {
    btn.addEventListener('click', () => decide(btn.dataset.draft, 'reject'));
  });

  const snap = document.getElementById('snap');
  const snapmsg = document.getElementById('snapmsg');
  if (snap) {
    snap.addEventListener('submit', async (e) => {
      e.preventDefault();
      snapmsg.textContent = 'Drafting…';
      const data = new FormData(snap);
      const res = await fetch('/api/drafts', { method: 'POST', body: data });
      if (res.ok) location.reload();
      else snapmsg.textContent = (await res.json()).error || 'could not draft';
    });
  }

  const form = document.getElementById('capture');
  const msg = document.getElementById('msg');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = 'Saving…';
    const body = { title: title.value, priceCents: Number(price.value) };
    const res = await fetch('/api/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) { location.reload(); }
    else { msg.textContent = (await res.json()).error || 'could not save'; }
  });
</script>
</body>
</html>`;
}
