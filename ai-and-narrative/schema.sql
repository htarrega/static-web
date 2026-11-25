-- Stats schema (idempotent). Apply with: wrangler d1 execute ai-and-narrative-stats --remote --file schema.sql
CREATE TABLE IF NOT EXISTS events (
  ts INTEGER NOT NULL,      -- epoch seconds
  day TEXT NOT NULL,        -- Europe/Madrid YYYY-MM-DD
  kind TEXT NOT NULL,       -- view | login | fail | lock | read
  pw TEXT,                  -- password name (never the typed text)
  device TEXT,              -- first 16 hex of sha256(session cookie)
  page TEXT,                -- 'index' | '1' | '2' ...
  lang TEXT,                -- es | en | null
  dtype TEXT,               -- mobile | tablet | desktop
  method TEXT,              -- typed | magic
  country TEXT,
  anon TEXT,                -- first 3 hex of sha256(ip|day); rotates daily
  view TEXT,                -- section id opened (read events)
  idx INTEGER               -- position of that section in the page (read events)
);
CREATE TABLE IF NOT EXISTS daily_requests (
  day TEXT PRIMARY KEY,
  n INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_kind_day ON events (kind, day);
CREATE INDEX IF NOT EXISTS idx_events_device ON events (device);
