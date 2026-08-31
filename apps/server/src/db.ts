import pg from "pg";
import { DATABASE_URL, balance } from "./config.js";

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      tg_id BIGINT UNIQUE NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      coins INTEGER NOT NULL DEFAULT ${balance.startCoins},
      time_offset BIGINT NOT NULL DEFAULT 0,
      phase_override TEXT,
      hammer_claimed BOOLEAN NOT NULL DEFAULT FALSE,
      admin_mode BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS inventory_slots (
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      container TEXT NOT NULL,
      slot_index INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      PRIMARY KEY (player_id, container, slot_index)
    );
    CREATE TABLE IF NOT EXISTS hives (
      id SERIAL PRIMARY KEY,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      hive_index INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'broken',
      level INTEGER NOT NULL DEFAULT 1,
      bee_slot_count INTEGER NOT NULL DEFAULT 0,
      honey INTEGER NOT NULL DEFAULT 0,
      honey_capacity INTEGER NOT NULL DEFAULT ${balance.honeyCapacity},
      last_prod_cycle BIGINT NOT NULL DEFAULT 0,
      UNIQUE (player_id, hive_index)
    );
    CREATE TABLE IF NOT EXISTS hive_bee_slots (
      hive_id INTEGER NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
      slot_index INTEGER NOT NULL,
      placed_cycle BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (hive_id, slot_index)
    );
    CREATE TABLE IF NOT EXISTS shop_state (
      player_id INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      refresh_at BIGINT NOT NULL,
      assortment JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_snapshots (
      player_id INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS globals (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
  `);
}

export async function getGlobal<T>(key: string): Promise<T | null> {
  const r = await pool.query("SELECT value FROM globals WHERE key=$1", [key]);
  return r.rows[0]?.value ?? null;
}

export async function setGlobal(key: string, value: unknown) {
  await pool.query(
    "INSERT INTO globals(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2",
    [key, JSON.stringify(value)]
  );
}
