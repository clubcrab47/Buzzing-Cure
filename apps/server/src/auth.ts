import crypto from "node:crypto";
import { BOT_TOKEN } from "./config.js";
import { pool } from "./db.js";

export type TgUser = { id: number; name: string };

// Validates Telegram WebApp initData signature (HMAC per official spec).
export function validateInitData(initData: string): TgUser | null {
  if (!BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (calc !== hash) return null;
  const user = JSON.parse(params.get("user") ?? "null");
  if (!user?.id) return null;
  return { id: Number(user.id), name: [user.first_name, user.last_name].filter(Boolean).join(" ") || String(user.id) };
}

export async function ensurePlayer(tg: TgUser) {
  let r = await pool.query("SELECT * FROM players WHERE tg_id=$1", [tg.id]);
  if (r.rows.length === 0) {
    r = await pool.query(
      "INSERT INTO players(tg_id, name) VALUES($1,$2) RETURNING *",
      [tg.id, tg.name]
    );
    const pid = r.rows[0].id;
    // Starting state: 1 bee in pocket, 8 coins (default), broken hive with 0 slots.
    await pool.query(
      "INSERT INTO inventory_slots(player_id, container, slot_index, item_id, qty) VALUES($1,'pockets',0,4,1)",
      [pid]
    );
    await pool.query(
      "INSERT INTO hives(player_id, hive_index, state, bee_slot_count, honey, honey_capacity, last_prod_cycle) VALUES($1,0,'broken',0,0,$2,0)",
      [pid, balance_honeyCap()]
    );
    await pool.query("INSERT INTO shop_state(player_id, refresh_at, assortment) VALUES($1,0,$2)", [
      pid,
      JSON.stringify([]),
    ]);
  } else {
    await pool.query("UPDATE players SET name=$2 WHERE id=$1", [r.rows[0].id, tg.name]);
  }
  return r.rows[0];
}

import { balance } from "./config.js";
const balance_honeyCap = () => balance.honeyCapacity;
