export const $ = (s, r = document) => r.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '–');
export const hrs = (h) => (h == null ? '–' : h < 48 ? `${h}h` : `${(h / 24).toFixed(1)}d`);
export async function api(path, opts = {}) {
  const res = await fetch(path, { method: opts.method || 'GET', headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || (data.errors || []).join('; ') || res.statusText), { status: res.status, data });
  return data;
}
export const options = (list, sel) => list.map((o) => `<option ${o === sel ? 'selected' : ''}>${esc(o)}</option>`).join('');
export function tabs(nav, panels, onShow) {
  const show = (id) => {
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === id));
    panels.forEach((p) => p.classList.toggle('hidden', p.id !== id));
    onShow?.(id);
  };
  nav.addEventListener('click', (e) => e.target.dataset.t && show(e.target.dataset.t));
  return show;
}
