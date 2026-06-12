import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "bot.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contract_address TEXT NOT NULL UNIQUE COLLATE NOCASE,
    min_price_eth REAL NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0,
    last_block INTEGER NOT NULL DEFAULT 0,
    phrases TEXT NOT NULL DEFAULT '[]',
    phrase_index INTEGER NOT NULL DEFAULT 0,
    track_mints INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tweeted (
    tx_hash TEXT NOT NULL,
    collection_id INTEGER NOT NULL,
    tweeted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tx_hash, collection_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Seed dry-run mode from the env on first run; afterwards the dashboard toggle owns it.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'dry_run'").get()) {
  const initial = process.env.DRY_RUN === "false" ? "false" : "true";
  db.prepare("INSERT INTO settings (key, value) VALUES ('dry_run', ?)").run(initial);
}

export function isDryRun(): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'dry_run'").get() as
    | { value: string }
    | undefined;
  return row?.value !== "false";
}

export function setDryRun(dryRun: boolean): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dry_run', ?)").run(
    dryRun ? "true" : "false"
  );
}

// Migration for databases created before the phrases feature
const existingColumns = (db.prepare("PRAGMA table_info(collections)").all() as { name: string }[]).map(
  (c) => c.name
);
if (!existingColumns.includes("phrases")) {
  db.exec("ALTER TABLE collections ADD COLUMN phrases TEXT NOT NULL DEFAULT '[]'");
}
if (!existingColumns.includes("phrase_index")) {
  db.exec("ALTER TABLE collections ADD COLUMN phrase_index INTEGER NOT NULL DEFAULT 0");
}
if (!existingColumns.includes("track_mints")) {
  db.exec("ALTER TABLE collections ADD COLUMN track_mints INTEGER NOT NULL DEFAULT 1");
}

export interface Collection {
  id: number;
  name: string;
  contract_address: string;
  min_price_eth: number;
  paused: number;
  last_block: number;
  /** JSON array of strings, rotated one per sale tweet. */
  phrases: string;
  phrase_index: number;
  track_mints: number;
  created_at: string;
}

/**
 * Returns the next phrase in the collection's rotation (or null if none are
 * configured) and advances the rotation index.
 */
export function nextPhrase(collection: Collection): string | null {
  let phrases: string[] = [];
  try {
    const parsed = JSON.parse(collection.phrases);
    if (Array.isArray(parsed)) phrases = parsed.filter((p) => typeof p === "string" && p.trim());
  } catch {
    /* malformed phrases column, treat as empty */
  }
  if (phrases.length === 0) return null;

  const phrase = phrases[collection.phrase_index % phrases.length];
  collection.phrase_index += 1;
  db.prepare("UPDATE collections SET phrase_index = ? WHERE id = ?").run(
    collection.phrase_index,
    collection.id
  );
  return phrase;
}

export function listCollections(): Collection[] {
  return db.prepare("SELECT * FROM collections ORDER BY created_at DESC").all() as Collection[];
}

export function getActiveCollections(): Collection[] {
  return db.prepare("SELECT * FROM collections WHERE paused = 0").all() as Collection[];
}

export function addCollection(
  name: string,
  contractAddress: string,
  minPriceEth: number,
  lastBlock: number
): Collection {
  const result = db
    .prepare(
      "INSERT INTO collections (name, contract_address, min_price_eth, last_block) VALUES (?, ?, ?, ?)"
    )
    .run(name, contractAddress.toLowerCase(), minPriceEth, lastBlock);
  return db
    .prepare("SELECT * FROM collections WHERE id = ?")
    .get(result.lastInsertRowid) as Collection;
}

export function updateCollection(
  id: number,
  fields: {
    name?: string;
    min_price_eth?: number;
    paused?: number;
    phrases?: string;
    track_mints?: number;
  }
): Collection | undefined {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    values.push(fields.name);
  }
  if (fields.phrases !== undefined) {
    sets.push("phrases = ?", "phrase_index = 0");
    values.push(fields.phrases);
  }
  if (fields.min_price_eth !== undefined) {
    sets.push("min_price_eth = ?");
    values.push(fields.min_price_eth);
  }
  if (fields.paused !== undefined) {
    sets.push("paused = ?");
    values.push(fields.paused);
  }
  if (fields.track_mints !== undefined) {
    sets.push("track_mints = ?");
    values.push(fields.track_mints);
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE collections SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }
  return db.prepare("SELECT * FROM collections WHERE id = ?").get(id) as Collection | undefined;
}

export function deleteCollection(id: number): void {
  db.prepare("DELETE FROM collections WHERE id = ?").run(id);
  db.prepare("DELETE FROM tweeted WHERE collection_id = ?").run(id);
}

export function setLastBlock(id: number, block: number): void {
  db.prepare("UPDATE collections SET last_block = ? WHERE id = ?").run(block, id);
}

export function hasTweeted(txHash: string, collectionId: number): boolean {
  return (
    db
      .prepare("SELECT 1 FROM tweeted WHERE tx_hash = ? AND collection_id = ?")
      .get(txHash, collectionId) !== undefined
  );
}

export function markTweeted(txHash: string, collectionId: number): void {
  db.prepare("INSERT OR IGNORE INTO tweeted (tx_hash, collection_id) VALUES (?, ?)").run(
    txHash,
    collectionId
  );
}

/** Prune dedupe rows older than 30 days to keep the table small. */
export function pruneTweeted(): void {
  db.prepare("DELETE FROM tweeted WHERE tweeted_at < datetime('now', '-30 days')").run();
}
