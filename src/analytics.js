import { CATEGORIES, PRIORITIES } from './db.js';

const DAY = 86400_000;
const HOUR = 3600_000;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

function summarize(rows, now) {
  const resolved = rows.filter((t) => t.resolved_at);
  const tat = resolved.map((t) => (t.resolved_at - t.created_at) / HOUR);
  const frt = rows.filter((t) => t.first_response_at).map((t) => (t.first_response_at - t.created_at) / HOUR);
  const withinSla = resolved.filter((t) => t.resolved_at <= t.due_at).length;
  return {
    created: rows.length,
    resolved: resolved.length,
    open: rows.filter((t) => !t.resolved_at).length,
    overdue: rows.filter((t) => !t.resolved_at && t.due_at < now).length,
    avg_tat_hours: round(avg(tat)),
    median_tat_hours: round(median(tat)),
    avg_first_response_hours: round(avg(frt)),
    sla_met_pct: resolved.length ? round((withinSla / resolved.length) * 100, 0) : null,
  };
}

const group = (rows, keyFn, keys, now) =>
  keys.map((k) => ({ key: k, ...summarize(rows.filter((t) => keyFn(t) === k), now) }));

/** days = look-back window on ticket creation date. */
export function buildAnalytics(db, { days = 30, now = Date.now() } = {}) {
  const since = now - days * DAY;
  const rows = db.prepare('SELECT * FROM tickets WHERE created_at >= ?').all(since);
  const agents = db.prepare('SELECT id, name, active FROM agents').all();
  const teams = [...new Set(rows.map((t) => t.team || '(unspecified)'))].sort();

  // Daily created vs resolved, oldest first.
  const trend = [];
  for (let i = days - 1; i >= 0; i--) {
    const start = new Date(now - i * DAY); start.setUTCHours(0, 0, 0, 0);
    const s = start.getTime(), e = s + DAY;
    trend.push({
      date: start.toISOString().slice(0, 10),
      created: rows.filter((t) => t.created_at >= s && t.created_at < e).length,
      resolved: rows.filter((t) => t.resolved_at && t.resolved_at >= s && t.resolved_at < e).length,
    });
  }

  const bot = db.prepare('SELECT * FROM bot_logs WHERE created_at >= ?').all(since);
  const unanswered = {};
  for (const b of bot.filter((x) => !x.answered)) unanswered[b.question.toLowerCase()] = (unanswered[b.question.toLowerCase()] || 0) + 1;

  return {
    window_days: days,
    overview: summarize(rows, now),
    by_agent: agents.map((a) => ({ agent_id: a.id, name: a.name, active: !!a.active, ...summarize(rows.filter((t) => t.agent_id === a.id), now) })),
    unassigned: rows.filter((t) => t.agent_id == null && !t.resolved_at).length,
    by_category: group(rows, (t) => t.category, CATEGORIES, now),
    by_priority: group(rows, (t) => t.priority, PRIORITIES, now),
    by_team: group(rows, (t) => t.team || '(unspecified)', teams, now),
    trend,
    bot: {
      questions: bot.length,
      answered: bot.filter((b) => b.answered).length,
      helpful: bot.filter((b) => b.helpful === 1).length,
      not_helpful: bot.filter((b) => b.helpful === 0).length,
      top_unanswered: Object.entries(unanswered).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([question, count]) => ({ question, count })),
    },
  };
}
