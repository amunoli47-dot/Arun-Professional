import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, seedIfEmpty, getSla, CATEGORIES, PRIORITIES, STATUSES, DEFAULT_SLA_HOURS } from './db.js';
import { createTicket, findByCode, getTicket, listTickets, updateTicket, addComment, listComments } from './tickets.js';
import { buildAnalytics } from './analytics.js';
import { searchKb, llmAnswer } from './kb.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

export function createApp({ db, adminPassword = process.env.ADMIN_PASSWORD || 'changeme', secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex') } = {}) {
  const sign = (v) => crypto.createHmac('sha256', secret).update(v).digest('hex');
  const token = sign('bizops-admin');
  const isAdmin = (req) => (req.headers.cookie || '').split(';').some((c) => c.trim() === `session=${token}`);

  const json = (res, code, body, headers = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid json')); } });
  });

  async function api(req, res, url) {
    const { pathname: p } = url, m = req.method;
    let mt;

    // ---- public ----
    if (p === '/api/meta' && m === 'GET') return json(res, 200, { categories: CATEGORIES, priorities: PRIORITIES, statuses: STATUSES, sla_hours: getSla(db) });
    if (p === '/api/login' && m === 'POST') {
      const { password } = await readBody(req);
      const ok = typeof password === 'string' && password.length === adminPassword.length &&
        crypto.timingSafeEqual(Buffer.from(password), Buffer.from(adminPassword));
      return ok ? json(res, 200, { ok: true }, { 'set-cookie': `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400` })
                : json(res, 401, { error: 'wrong password' });
    }
    if (p === '/api/logout' && m === 'POST') return json(res, 200, { ok: true }, { 'set-cookie': 'session=; Path=/; Max-Age=0' });
    if (p === '/api/session' && m === 'GET') return json(res, 200, { admin: isAdmin(req) });

    if (p === '/api/tickets' && m === 'POST') {
      const r = createTicket(db, await readBody(req));
      if (r.errors) return json(res, 400, { errors: r.errors });
      const t = r.ticket;
      return json(res, 201, { code: t.code, agent: t.agent_name, due_at: t.due_at, status: t.status });
    }
    if (p === '/api/track' && m === 'GET') {
      const t = findByCode(db, url.searchParams.get('code') || '');
      // Requires matching email so ticket codes alone can't be enumerated.
      if (!t || t.requester_email.toLowerCase() !== (url.searchParams.get('email') || '').trim().toLowerCase()) return json(res, 404, { error: 'No ticket found for that code and email' });
      return json(res, 200, {
        code: t.code, title: t.title, status: t.status, category: t.category, priority: t.priority,
        agent: t.agent_name, created_at: t.created_at, due_at: t.due_at, resolved_at: t.resolved_at,
        resolution_note: t.resolution_note, comments: listComments(db, t.id, false).map(({ author, body, created_at }) => ({ author, body, created_at })),
      });
    }
    if (p === '/api/bot' && m === 'POST') {
      const { message } = await readBody(req);
      if (!String(message || '').trim()) return json(res, 400, { error: 'message is required' });
      const hits = searchKb(db, message);
      const answered = hits.length > 0;
      const log = db.prepare('INSERT INTO bot_logs (question, article_id, score, answered, created_at) VALUES (?,?,?,?,?)')
        .run(String(message).slice(0, 500), hits[0]?.article.id ?? null, hits[0]?.score ?? 0, answered ? 1 : 0, Date.now());
      const summary = answered ? await llmAnswer(message, hits) : null;
      return json(res, 200, {
        log_id: Number(log.lastInsertRowid),
        answered,
        summary,
        sources: hits.map((h) => ({ id: h.article.id, title: h.article.title, category: h.article.category, body: h.article.body })),
        suggest_ticket: !answered ? 'I could not find prerequisites for that. You can raise a request and the team will pick it up.' : null,
      });
    }
    if ((mt = /^\/api\/bot\/(\d+)\/feedback$/.exec(p)) && m === 'POST') {
      const { helpful } = await readBody(req);
      db.prepare('UPDATE bot_logs SET helpful=? WHERE id=?').run(helpful ? 1 : 0, Number(mt[1]));
      return json(res, 200, { ok: true });
    }

    // ---- everything below needs the team password ----
    if (!isAdmin(req)) return json(res, 401, { error: 'login required' });

    if (p === '/api/admin/tickets' && m === 'GET') return json(res, 200, listTickets(db, Object.fromEntries(url.searchParams)));
    if ((mt = /^\/api\/admin\/tickets\/(\d+)$/.exec(p))) {
      const id = Number(mt[1]);
      if (m === 'GET') {
        const t = getTicket(db, id);
        return t ? json(res, 200, { ...t, comments: listComments(db, id, true) }) : json(res, 404, { error: 'not found' });
      }
      if (m === 'PATCH') {
        const r = updateTicket(db, id, await readBody(req));
        return r.error ? json(res, r.status, { error: r.error }) : json(res, 200, r.ticket);
      }
    }
    if ((mt = /^\/api\/admin\/tickets\/(\d+)\/comments$/.exec(p)) && m === 'POST') {
      const r = addComment(db, Number(mt[1]), await readBody(req));
      return r.error ? json(res, r.status, { error: r.error }) : json(res, 201, r);
    }
    if (p === '/api/admin/analytics' && m === 'GET') {
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
      return json(res, 200, buildAnalytics(db, { days }));
    }

    if (p === '/api/admin/agents' && m === 'GET') return json(res, 200, db.prepare('SELECT * FROM agents ORDER BY id').all().map((a) => ({ ...a, categories: JSON.parse(a.categories) })));
    if (p === '/api/admin/agents' && m === 'POST') {
      const b = await readBody(req);
      if (!String(b.name || '').trim()) return json(res, 400, { error: 'name is required' });
      const cats = (b.categories || []).filter((c) => CATEGORIES.includes(c));
      const r = db.prepare('INSERT INTO agents (name, email, categories) VALUES (?,?,?)').run(b.name.trim(), b.email || '', JSON.stringify(cats));
      return json(res, 201, { id: Number(r.lastInsertRowid) });
    }
    if ((mt = /^\/api\/admin\/agents\/(\d+)$/.exec(p)) && m === 'PATCH') {
      const b = await readBody(req), id = Number(mt[1]);
      if (b.name !== undefined) db.prepare('UPDATE agents SET name=? WHERE id=?').run(String(b.name), id);
      if (b.email !== undefined) db.prepare('UPDATE agents SET email=? WHERE id=?').run(String(b.email), id);
      if (b.active !== undefined) db.prepare('UPDATE agents SET active=? WHERE id=?').run(b.active ? 1 : 0, id);
      if (b.categories !== undefined) db.prepare('UPDATE agents SET categories=? WHERE id=?').run(JSON.stringify(b.categories.filter((c) => CATEGORIES.includes(c))), id);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/admin/kb' && m === 'GET') return json(res, 200, db.prepare('SELECT * FROM kb_articles ORDER BY category, title').all());
    if (p === '/api/admin/kb' && m === 'POST') {
      const b = await readBody(req);
      if (!String(b.title || '').trim() || !String(b.body || '').trim() || !CATEGORIES.includes(b.category)) return json(res, 400, { error: 'title, body and a valid category are required' });
      const r = db.prepare('INSERT INTO kb_articles (title, category, keywords, body, updated_at) VALUES (?,?,?,?,?)').run(b.title.trim(), b.category, b.keywords || '', b.body, Date.now());
      return json(res, 201, { id: Number(r.lastInsertRowid) });
    }
    if ((mt = /^\/api\/admin\/kb\/(\d+)$/.exec(p))) {
      const id = Number(mt[1]);
      if (m === 'PUT') {
        const b = await readBody(req);
        if (!String(b.title || '').trim() || !String(b.body || '').trim() || !CATEGORIES.includes(b.category)) return json(res, 400, { error: 'title, body and a valid category are required' });
        db.prepare('UPDATE kb_articles SET title=?, category=?, keywords=?, body=?, updated_at=? WHERE id=?').run(b.title.trim(), b.category, b.keywords || '', b.body, Date.now(), id);
        return json(res, 200, { ok: true });
      }
      if (m === 'DELETE') { db.prepare('DELETE FROM kb_articles WHERE id=?').run(id); return json(res, 200, { ok: true }); }
    }

    if (p === '/api/admin/settings' && m === 'PUT') {
      const { sla_hours } = await readBody(req);
      const clean = {};
      for (const k of PRIORITIES) {
        const n = Number(sla_hours?.[k]);
        clean[k] = Number.isFinite(n) && n > 0 ? n : DEFAULT_SLA_HOURS[k];
      }
      db.prepare("INSERT INTO settings (key, value) VALUES ('sla_hours', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(clean));
      return json(res, 200, { sla_hours: clean });
    }
    return json(res, 404, { error: 'not found' });
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'portal.html' : pathname === '/console' ? 'console.html' : pathname.slice(1);
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else serveStatic(res, url.pathname);
    } catch (e) {
      json(res, e.message === 'invalid json' ? 400 : 500, { error: e.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync('data', { recursive: true });
  const db = openDb();
  seedIfEmpty(db);
  const port = Number(process.env.PORT) || 3000;
  if (!process.env.ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD not set, using the default "changeme". Set it before sharing the app.');
  createApp({ db }).listen(port, () => console.log(`BizOps Desk running:\n  Requesters + bot: http://localhost:${port}/\n  Team console:     http://localhost:${port}/console`));
}
