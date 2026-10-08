import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, seedIfEmpty } from '../src/db.js';
import { createTicket, updateTicket, pickAgent } from '../src/tickets.js';
import { buildAnalytics } from '../src/analytics.js';
import { searchKb } from '../src/kb.js';
import { createApp } from '../src/server.js';

const fresh = () => { const db = openDb(':memory:'); seedIfEmpty(db); return db; };
const base = { requester_name: 'Ravi', requester_email: 'ravi@x.com', title: 'New form', category: 'Product Forms', team: 'Sales' };

test('validation rejects bad input', () => {
  assert.ok(createTicket(fresh(), { ...base, requester_email: 'nope' }).errors.length);
  assert.ok(createTicket(fresh(), { ...base, category: 'Bogus' }).errors.length);
});

test('assigns by skill, then balances load', () => {
  const db = fresh();
  const t1 = createTicket(db, base).ticket;
  assert.equal(t1.agent_name, 'Agent Two'); // only Agent Two has Product Forms skill
  const crm = [1, 2, 3, 4].map(() => createTicket(db, { ...base, category: 'CRM' }).ticket.agent_name);
  assert.deepEqual(crm.sort(), ['Agent One', 'Agent One', 'Agent Three', 'Agent Three']);
});

test('inactive agents are skipped; falls back to anyone when no skill match', () => {
  const db = fresh();
  db.prepare("UPDATE agents SET active=0 WHERE name='Agent Two'").run();
  assert.notEqual(pickAgent(db, 'Product Forms').name, 'Agent Two');
});

test('resolving records TAT; analytics computes it', () => {
  const db = fresh(); const now = Date.now();
  const t = createTicket(db, { ...base, priority: 'high' }, now - 10 * 3600_000).ticket;
  updateTicket(db, t.id, { status: 'resolved' }, 'a', now - 4 * 3600_000);
  const a = buildAnalytics(db, { days: 7, now });
  assert.equal(a.overview.resolved, 1);
  assert.equal(a.overview.avg_tat_hours, 6);
  assert.equal(a.overview.sla_met_pct, 100);
  assert.equal(a.by_agent.find((x) => x.name === 'Agent Two').resolved, 1);
});

test('late resolution counts as SLA miss', () => {
  const db = fresh(); const now = Date.now();
  const t = createTicket(db, { ...base, priority: 'urgent' }, now - 48 * 3600_000).ticket;
  updateTicket(db, t.id, { status: 'resolved' }, 'a', now);
  assert.equal(buildAnalytics(db, { days: 7, now }).overview.sla_met_pct, 0);
});

test('bot finds prerequisites and misses gibberish', () => {
  const db = fresh();
  assert.match(searchKb(db, 'what do I need for a new product form?')[0].article.title, /product form/i);
  assert.match(searchKb(db, 'we want to connect a webhook to a third party tool')[0].article.title, /integration/i);
  assert.equal(searchKb(db, 'zzzz qqqq').length, 0);
});

test('http: public intake, auth-gated console, tracking needs email', async () => {
  const db = fresh();
  const server = createApp({ db, adminPassword: 'pw', secret: 's' }).listen(0);
  const base_ = `http://localhost:${server.address().port}`;
  const j = (p, o = {}) => fetch(base_ + p, { ...o, headers: { 'content-type': 'application/json', ...(o.headers || {}) }, body: o.body && JSON.stringify(o.body) });
  try {
    const c = await (await j('/api/tickets', { method: 'POST', body: base })).json();
    assert.match(c.code, /^BOPS-\d{4}$/);
    assert.equal((await j('/api/admin/tickets')).status, 401);
    assert.equal((await j('/api/login', { method: 'POST', body: { password: 'bad' } })).status, 401);
    const login = await j('/api/login', { method: 'POST', body: { password: 'pw' } });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const list = await (await j('/api/admin/tickets', { headers: { cookie } })).json();
    assert.equal(list.length, 1);
    assert.equal((await j(`/api/track?code=${c.code}&email=wrong@x.com`)).status, 404);
    assert.equal((await j(`/api/track?code=${c.code}&email=ravi@x.com`)).status, 200);
    const bot = await (await j('/api/bot', { method: 'POST', body: { message: 'prerequisites for a new lead source' } })).json();
    assert.ok(bot.answered);
    assert.equal((await (await fetch(base_ + '/')).text()).includes('Business Operations Desk'), true);
    assert.equal((await fetch(base_ + '/../package.json')).status, 404);
  } finally { server.close(); }
});
