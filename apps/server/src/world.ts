import { game, CYCLE } from "./config.js";
import { pool } from "./db.js";

export type Phase = "day" | "night";

// Player-local time: admin debug offset/override shifts only this player's view.
export function worldTime(nowMs: number, offsetSec: number, override: string | null) {
  const now = Math.floor(nowMs / 1000) + offsetSec;
  const elapsed = now - game.worldEpoch;
  const cycle = Math.floor(elapsed / CYCLE);
  const intoCycle = ((elapsed % CYCLE) + CYCLE) % CYCLE;
  let phase: Phase = intoCycle < game.daySeconds ? "day" : "night";
  if (override === "day" || override === "night") phase = override;
  const phaseEnd =
    game.worldEpoch + cycle * CYCLE + (phase === "day" ? game.daySeconds : CYCLE);
  const timeLeft = Math.max(0, phaseEnd - now);
  return { cycle, phase, timeLeft };
}

export function realCycle(nowMs: number) {
  return worldTime(nowMs, 0, null).cycle;
}

// Lazy production: each fully completed cycle with bee(s) in the hive yields
// 1 honey per bee, capped by hive capacity. Permissive on mid-phase placement.
export async function updateProduction(playerId: number, nowMs: number) {
  const cycle = realCycle(nowMs);
  const hives = await pool.query(
    "SELECT id, honey, honey_capacity, last_prod_cycle, bee_slot_count FROM hives WHERE player_id=$1 AND state='working'",
    [playerId]
  );
  for (const h of hives.rows) {
    const bees = await pool.query("SELECT count(*)::int AS n FROM hive_bee_slots WHERE hive_id=$1", [h.id]);
    const n = bees.rows[0].n;
    const done = Math.max(0, cycle - Number(h.last_prod_cycle));
    const gain = Math.min(h.honey_capacity - h.honey, n * done);
    await pool.query(
      "UPDATE hives SET honey = honey + $1, last_prod_cycle=$2 WHERE id=$3",
      [gain, cycle, h.id]
    );
  }
}
