# BizOps Desk

Request desk for a Business Operations team (CRM, Leads, Product Forms, Marketing Communications, Integrations, Other).

- **Requester portal** (`/`): raise a request, track it with code + email, and ask the **prerequisites bot** what to prepare first.
- **Auto-assignment**: each new ticket goes to the active agent with matching skills and the fewest open tickets.
- **Team console** (`/console`, password protected): tickets, agents and skills, knowledge base editor, SLA settings, and the analytics dashboard.
- **Analytics**: tickets per agent, turnaround time (avg/median), first-response time, SLA met %, overdue, volume by request type / requesting team / priority, daily trend, and bot stats (including questions the bot could not answer, i.e. knowledge-base gaps).

## Run

Needs Node >= 22.13. No npm dependencies.

```
ADMIN_PASSWORD=choose-a-password npm start    # http://localhost:3000
npm test
```

Env vars: `ADMIN_PASSWORD` (default `changeme`), `PORT`, `DB_FILE` (default `data/bizops.db`), `SESSION_SECRET`.
First start seeds 3 placeholder agents and 5 prerequisite articles. Replace them in the console.

## Bot

Retrieval over the knowledge base (keywords weigh most, then title, category, body) with no external service. If `ANTHROPIC_API_KEY` is set (optional `BOT_MODEL`), the bot also writes a short checklist answer strictly from the matched articles. Tip: fill the *Keywords* field of each article with the words requesters actually use.

## Known limits / next steps

- One shared team password, no per-agent login or SSO; agents are picked from a list when commenting.
- No email/Slack notifications yet; no attachments.
- SQLite file storage: fine for one server, not for multiple instances.
