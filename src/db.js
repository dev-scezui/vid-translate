import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const file = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "vid-translate.db");
if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    email        TEXT UNIQUE NOT NULL,
    api_key_hash TEXT UNIQUE NOT NULL,
    plan         TEXT NOT NULL DEFAULT 'free',
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- One row per job. 'pending' and 'done' count against the quota; 'failed' is refunded.
  CREATE TABLE IF NOT EXISTS usage (
    job_id       TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    status       TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
    duration_sec REAL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS usage_user_month ON usage (user_id, created_at);
`);

// Jobs that were mid-flight when the server last stopped will never finish; refund them.
db.prepare("UPDATE usage SET status = 'failed' WHERE status = 'pending'").run();
