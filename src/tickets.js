import { ticketCode, getSla, CATEGORIES, PRIORITIES, STATUSES } from './db.js';

const HOUR = 3600_000;

export function pickAgent(db, category) {
  const agents = db.prepare('SELECT * FROM agents WHERE active=1').all()
    .map((a) => ({ ...a, categories: JSON.parse(a.categories) }));
  if (!agents.length) return null;
  const skilled = agents.filter((a) => a.categories.length === 0 || a.categories.includes(category));
  const pool = skilled.length ? skilled : agents;
  const load = db.prepare("SELECT COUNT(*) c FROM tickets WHERE agent_id=? AND status!='resolved'");
  const total = db.prepare('SELECT COUNT(*) c FROM tickets WHERE agent_id=?');
  // Least open tickets first; tie-break on fewest tickets ever assigned so work spreads evenly.
  return pool
    .map((a) => ({ a, open: load.get(a.id).c, all: total.get(a.id).c }))
    .sort((x, y) => x.open - y.open || x.all - y.all || x.a.id - y.a.id)[0].a;
}

export function createTicket(db, input, now = Date.now()) {
  const v = (k) => String(input[k] ?? '').trim();
  const errors = [];
  if (!v('requester_name')) errors.push('requester_name is required');
  if (!/^\S+@\S+\.\S+$/.test(v('requester_email'))) errors.push('a valid requester_email is required');
  if (!v('title')) errors.push('title is required');
  const category = CATEGORIES.includes(v('category')) ? v('category') : null;
  if (!category) errors.push(`category must be one of: ${CATEGORIES.join(', ')}`);
  const priority = v('priority') || 'medium';
  if (!PRIORITIES.includes(priority)) errors.push(`priority must be one of: ${PRIORITIES.join(', ')}`);
  if (errors.length) return { errors };

  const agent = pickAgent(db, category);
  const due = now + getSla(db)[priority] * HOUR;
  const r = db.prepare(`INSERT INTO tickets
    (title, description, requester_name, requester_email, team, category, priority, agent_id, created_at, due_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(v('title'), v('description'), v('requester_name'), v('requester_email'), v('team'), category, priority, agent?.id ?? null, now, due);
  return { ticket: getTicket(db, Number(r.lastInsertRowid)) };
}

const SELECT = `SELECT t.*, a.name AS agent_name FROM tickets t LEFT JOIN agents a ON a.id=t.agent_id`;
const decorate = (t) => t && { ...t, code: ticketCode(t.id), sla_breached: isBreached(t) };
export const isBreached = (t, now = Date.now()) => (t.resolved_at ?? now) > t.due_at;

export const getTicket = (db, id) => decorate(db.prepare(`${SELECT} WHERE t.id=?`).get(id));

export function findByCode(db, code) {
  const m = /^BOPS-0*(\d+)$/i.exec(String(code).trim());
  return m ? getTicket(db, Number(m[1])) : null;
}

export function listTickets(db, { status, agent_id, category, q } = {}) {
  const where = [], args = [];
  if (status === 'active') where.push("t.status!='resolved'");
  else if (status) { where.push('t.status=?'); args.push(status); }
  if (agent_id === 'unassigned') where.push('t.agent_id IS NULL');
  else if (agent_id) { where.push('t.agent_id=?'); args.push(Number(agent_id)); }
  if (category) { where.push('t.category=?'); args.push(category); }
  if (q) { where.push('(t.title LIKE ? OR t.requester_name LIKE ? OR t.team LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const sql = `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.created_at DESC LIMIT 500`;
  return db.prepare(sql).all(...args).map(decorate);
}

export function updateTicket(db, id, patch, author = 'agent', now = Date.now()) {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
  if (!t) return { error: 'not found', status: 404 };
  const sets = [], args = [];
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) return { error: 'invalid status', status: 400 };
    sets.push('status=?'); args.push(patch.status);
    if (patch.status === 'resolved' && !t.resolved_at) { sets.push('resolved_at=?'); args.push(now); }
    if (patch.status !== 'resolved' && t.resolved_at) { sets.push('resolved_at=NULL'); } // reopened
    if (!t.first_response_at && patch.status !== 'open') { sets.push('first_response_at=?'); args.push(now); }
  }
  if (patch.agent_id !== undefined) {
    if (patch.agent_id !== null && !db.prepare('SELECT 1 FROM agents WHERE id=?').get(patch.agent_id)) return { error: 'unknown agent', status: 400 };
    sets.push('agent_id=?'); args.push(patch.agent_id);
  }
  if (patch.priority !== undefined) {
    if (!PRIORITIES.includes(patch.priority)) return { error: 'invalid priority', status: 400 };
    sets.push('priority=?', 'due_at=?'); args.push(patch.priority, t.created_at + getSla(db)[patch.priority] * HOUR);
  }
  if (patch.category !== undefined) {
    if (!CATEGORIES.includes(patch.category)) return { error: 'invalid category', status: 400 };
    sets.push('category=?'); args.push(patch.category);
  }
  if (patch.resolution_note !== undefined) { sets.push('resolution_note=?'); args.push(String(patch.resolution_note)); }
  if (sets.length) db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id=?`).run(...args, id);
  return { ticket: getTicket(db, id) };
}

export function addComment(db, ticketId, { author, body, internal }, now = Date.now()) {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (!t) return { error: 'not found', status: 404 };
  if (!String(body ?? '').trim()) return { error: 'body is required', status: 400 };
  db.prepare('INSERT INTO comments (ticket_id, author, body, internal, created_at) VALUES (?,?,?,?,?)')
    .run(ticketId, String(author || 'agent'), String(body).trim(), internal ? 1 : 0, now);
  // A public reply from the team counts as the first response.
  if (!internal && !t.first_response_at && author !== 'requester') {
    db.prepare('UPDATE tickets SET first_response_at=? WHERE id=?').run(now, ticketId);
  }
  return { ok: true };
}

export const listComments = (db, ticketId, includeInternal) =>
  db.prepare(`SELECT * FROM comments WHERE ticket_id=? ${includeInternal ? '' : 'AND internal=0'} ORDER BY created_at`).all(ticketId);
