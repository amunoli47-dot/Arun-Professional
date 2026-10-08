import { DatabaseSync } from 'node:sqlite';

export const CATEGORIES = ['CRM', 'Leads', 'Product Forms', 'Marketing Communications', 'Integrations', 'Other'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const STATUSES = ['open', 'in_progress', 'waiting', 'resolved'];
export const DEFAULT_SLA_HOURS = { low: 120, medium: 72, high: 24, urgent: 8 };

export function openDb(file = process.env.DB_FILE || 'data/bizops.db') {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      categories TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      requester_name TEXT NOT NULL,
      requester_email TEXT NOT NULL,
      team TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      agent_id INTEGER REFERENCES agents(id),
      created_at INTEGER NOT NULL,
      first_response_at INTEGER,
      resolved_at INTEGER,
      due_at INTEGER NOT NULL,
      resolution_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_agent ON tickets(agent_id, status);
    CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created_at);
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      internal INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kb_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bot_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      article_id INTEGER,
      score REAL NOT NULL DEFAULT 0,
      answered INTEGER NOT NULL DEFAULT 0,
      helpful INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

export const ticketCode = (id) => `BOPS-${String(id).padStart(4, '0')}`;

export function getSla(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key='sla_hours'").get();
  return { ...DEFAULT_SLA_HOURS, ...(row ? JSON.parse(row.value) : {}) };
}

export function seedIfEmpty(db) {
  if (db.prepare('SELECT COUNT(*) c FROM agents').get().c === 0) {
    const ins = db.prepare('INSERT INTO agents (name, email, categories) VALUES (?,?,?)');
    ins.run('Agent One', 'agent1@example.com', JSON.stringify(['CRM', 'Leads']));
    ins.run('Agent Two', 'agent2@example.com', JSON.stringify(['Product Forms', 'Marketing Communications']));
    ins.run('Agent Three', 'agent3@example.com', JSON.stringify(['Integrations', 'CRM']));
  }
  if (db.prepare('SELECT COUNT(*) c FROM kb_articles').get().c === 0) {
    const ins = db.prepare('INSERT INTO kb_articles (title, category, keywords, body, updated_at) VALUES (?,?,?,?,?)');
    const now = Date.now();
    ins.run('Prerequisites: New lead source or lead routing change', 'Leads',
      'lead source routing assignment utm round robin new campaign leads',
      '- Name of the lead source and the owning team\n- UTM parameters / source tags to be captured\n- Routing rule: owner, round-robin pool, or queue\n- Expected daily lead volume\n- Go-live date (allow 3 working days)\n- Sample test lead details for QA', now);
    ins.run('Prerequisites: New or changed product form', 'Product Forms',
      'form product field new form change fields validation landing page',
      '- Form purpose and the product it belongs to\n- Final field list with types, mandatory flags and validations\n- Where the form is embedded (URL / page)\n- CRM object and field each answer maps to\n- Thank-you message or redirect\n- Approved copy and consent text', now);
    ins.run('Prerequisites: Marketing email / WhatsApp / SMS communication', 'Marketing Communications',
      'email whatsapp sms campaign communication template broadcast audience',
      '- Audience definition (segment filters, approx. size)\n- Approved content and template (WhatsApp templates need pre-approval)\n- Send date/time and any throttling\n- Sender ID / from address\n- Unsubscribe / opt-out handling confirmed\n- Success metric to be tracked', now);
    ins.run('Prerequisites: CRM change (fields, objects, reports, access)', 'CRM',
      'crm field object report dashboard access permission profile salesforce workflow',
      '- Business problem and expected outcome\n- Object(s) and field(s) affected, with API names if known\n- Who needs access / which profile or role\n- Reports or dashboards impacted\n- Approver from the requesting team\n- Deadline and reason', now);
    ins.run('Prerequisites: New integration or API / webhook connection', 'Integrations',
      'integration api webhook sync third party tool connect data payload',
      '- Systems involved and direction of data flow\n- Trigger event and frequency (real-time / batch)\n- Sample payload and field mapping\n- Auth method and who owns credentials\n- Error handling expectations\n- Owner on the other side for testing', now);
  }
}
