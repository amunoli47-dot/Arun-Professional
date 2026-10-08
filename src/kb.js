// Lightweight keyword retrieval over the knowledge base (no external services needed).
const STOP = new Set('a an the is are was be to of for in on at and or i we you my our do does need needs want how what which can should this that with from it as by if about please'.split(' '));

export const tokenize = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));

export function searchKb(db, question, limit = 3) {
  const q = new Set(tokenize(question));
  if (!q.size) return [];
  const articles = db.prepare('SELECT * FROM kb_articles').all();
  const scored = articles.map((a) => {
    const title = new Set(tokenize(a.title));
    const kw = new Set(tokenize(a.keywords));
    const cat = new Set(tokenize(a.category));
    const body = new Set(tokenize(a.body));
    let score = 0;
    for (const t of q) {
      if (kw.has(t)) score += 3;
      if (title.has(t)) score += 2.5;
      if (cat.has(t)) score += 2;
      if (body.has(t)) score += 1;
    }
    return { article: a, score: score / Math.sqrt(q.size) };
  });
  return scored.filter((s) => s.score >= 1.5).sort((a, b) => b.score - a.score).slice(0, limit);
}

// Optional: if ANTHROPIC_API_KEY is set, phrase the answer with Claude, strictly grounded in the KB hits.
export async function llmAnswer(question, hits) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !hits.length) return null;
  const context = hits.map((h, i) => `[${i + 1}] ${h.article.title}\n${h.article.body}`).join('\n\n');
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.BOT_MODEL || 'claude-sonnet-5-5',
        max_tokens: 600,
        system: 'You are the Business Operations prerequisites assistant. Answer ONLY from the provided knowledge base excerpts. Reply with a concise checklist of what the requester must have ready. If the excerpts do not answer the question, say so and suggest raising a ticket. Never invent requirements.',
        messages: [{ role: 'user', content: `Knowledge base:\n${context}\n\nQuestion: ${question}` }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.content?.map((c) => c.text).join('') || null;
  } catch {
    return null;
  }
}
