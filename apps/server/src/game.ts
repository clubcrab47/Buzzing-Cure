import { pool } from "./db.js";
import { balance, itemDef, CYCLE, game } from "./config.js";
import { realCycle, updateProduction, worldTime } from "./world.js";

export type Slot = { container: string; slot_index: number; item_id: number; qty: number } | null;

export class GameError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
  }
}

const POCKETS = "pockets";
const STORAGE = "storage";

export function containerSize(c: string) {
  if (c === POCKETS) return balance.pocketsSlots;
  if (c === STORAGE) return balance.storageSlots;
  throw new GameError("BAD_CONTAINER");
}

export async function getSlots(playerId: number) {
  const r = await pool.query(
    "SELECT container, slot_index, item_id, qty FROM inventory_slots WHERE player_id=$1 ORDER BY container, slot_index",
    [playerId]
  );
  return r.rows as { container: string; slot_index: number; item_id: number; qty: number }[];
}

export async function getHive(playerId: number) {
  const r = await pool.query("SELECT * FROM hives WHERE player_id=$1 AND hive_index=0", [playerId]);
  const hive = r.rows[0];
  if (!hive) throw new GameError("NO_HIVE");
  const bees = await pool.query(
    "SELECT slot_index, placed_cycle FROM hive_bee_slots WHERE hive_id=$1 ORDER BY slot_index",
    [hive.id]
  );
  return { ...hive, bees: bees.rows };
}

function emptySlot(slots: { container: string; slot_index: number }[], container: string) {
  const size = containerSize(container);
  const used = new Set(slots.filter((s) => s.container === container).map((s) => s.slot_index));
  for (let i = 0; i < size; i++) if (!used.has(i)) return i;
  return null;
}

async function getSlot(playerId: number, container: string, slot: number): Promise<Slot> {
  const r = await pool.query(
    "SELECT container, slot_index, item_id, qty FROM inventory_slots WHERE player_id=$1 AND container=$2 AND slot_index=$3",
    [playerId, container, slot]
  );
  return r.rows[0] ?? null;
}

async function clearSlot(playerId: number, container: string, slot: number) {
  await pool.query("DELETE FROM inventory_slots WHERE player_id=$1 AND container=$2 AND slot_index=$3", [playerId, container, slot]);
}

async function putSlot(playerId: number, container: string, slot: number, itemId: number, qty: number) {
  await pool.query(
    "INSERT INTO inventory_slots(player_id, container, slot_index, item_id, qty) VALUES($1,$2,$3,$4,$5)",
    [playerId, container, slot, itemId, qty]
  );
}

// move / merge / swap between any two slots (pockets, storage).
export async function move(playerId: number, fromC: string, fromS: number, toC: string, toS: number) {
  containerSize(fromC);
  containerSize(toC);
  if (fromS < 0 || toS < 0 || fromS >= containerSize(fromC) || toS >= containerSize(toC))
    throw new GameError("BAD_SLOT");
  const a = await getSlot(playerId, fromC, fromS);
  if (!a) throw new GameError("EMPTY_SOURCE");
  const b = await getSlot(playerId, toC, toS);
  if (!b) {
    await clearSlot(playerId, fromC, fromS);
    await putSlot(playerId, toC, toS, a.item_id, a.qty);
    return { result: "move" };
  }
  if (b.item_id === a.item_id) {
    const cap = itemDef(a.item_id).stack;
    const total = a.qty + b.qty;
    if (total > cap) {
      // partial merge: fill destination to cap, keep remainder in source
      await pool.query("UPDATE inventory_slots SET qty=$1 WHERE player_id=$2 AND container=$3 AND slot_index=$4", [cap, playerId, toC, toS]);
      await pool.query("UPDATE inventory_slots SET qty=$1 WHERE player_id=$2 AND container=$3 AND slot_index=$4", [total - cap, playerId, fromC, fromS]);
      return { result: "merge" };
    }
    await clearSlot(playerId, fromC, fromS);
    await pool.query("UPDATE inventory_slots SET qty=$1 WHERE player_id=$2 AND container=$3 AND slot_index=$4", [total, playerId, toC, toS]);
    return { result: "merge" };
  }
  // swap
  await pool.query(
    "UPDATE inventory_slots SET item_id=$1, qty=$2 WHERE player_id=$3 AND container=$4 AND slot_index=$5",
    [b.item_id, b.qty, playerId, fromC, fromS]
  );
  await pool.query(
    "UPDATE inventory_slots SET item_id=$1, qty=$2 WHERE player_id=$3 AND container=$4 AND slot_index=$5",
    [a.item_id, a.qty, playerId, toC, toS]
  );
  return { result: "swap" };
}

export async function addItem(playerId: number, itemId: number, qty: number) {
  const def = itemDef(itemId);
  const slots = await getSlots(playerId);
  // fill existing stacks first
  let left = qty;
  for (const s of slots.filter((s) => s.item_id === itemId && s.qty < def.stack)) {
    const add = Math.min(left, def.stack - s.qty);
    await pool.query("UPDATE inventory_slots SET qty=$1 WHERE player_id=$2 AND container=$3 AND slot_index=$4", [s.qty + add, playerId, s.container, s.slot_index]);
    left -= add;
    if (left <= 0) return true;
  }
  while (left > 0) {
    const free = emptySlot(slots, POCKETS);
    if (free === null) return false; // inventory full; caller decides
    const add = Math.min(left, def.stack);
    await putSlot(playerId, POCKETS, free, itemId, add);
    slots.push({ container: POCKETS, slot_index: free, item_id: itemId, qty: add });
    left -= add;
  }
  return true;
}

// ---- Hive ----

export async function placeBee(playerId: number, beeSlotIdx: number, nowMs: number) {
  const hive = await getHive(playerId);
  if (hive.state !== "working") throw new GameError("HIVE_BROKEN");
  if (beeSlotIdx < 0 || beeSlotIdx >= hive.bee_slot_count) throw new GameError("BAD_SLOT");
  const taken = await pool.query("SELECT 1 FROM hive_bee_slots WHERE hive_id=$1 AND slot_index=$2", [hive.id, beeSlotIdx]);
  if (taken.rows.length) throw new GameError("SLOT_TAKEN");
  // find bee in pockets
  const slots = await getSlots(playerId);
  const bee = slots.find((s) => s.container === POCKETS && s.item_id === 4);
  if (!bee) throw new GameError("NO_BEE");
  await clearSlot(playerId, POCKETS, bee.slot_index);
  await pool.query(
    "INSERT INTO hive_bee_slots(hive_id, slot_index, placed_cycle) VALUES($1,$2,$3)",
    [hive.id, beeSlotIdx, realCycle(nowMs)]
  );
}

export async function removeBee(playerId: number, beeSlotIdx: number) {
  const hive = await getHive(playerId);
  const r = await pool.query("DELETE FROM hive_bee_slots WHERE hive_id=$1 AND slot_index=$2 RETURNING 1", [hive.id, beeSlotIdx]);
  if (!r.rows.length) throw new GameError("NO_BEE_IN_SLOT");
  const ok = await addItem(playerId, 4, 1);
  if (!ok) throw new GameError("POCKETS_FULL");
}

export async function collectHoney(playerId: number) {
  const hive = await getHive(playerId);
  if (hive.honey <= 0) throw new GameError("NO_HONEY");
  const slots = await getSlots(playerId);
  const free = emptySlot(slots, POCKETS);
  if (free === null) throw new GameError("POCKETS_FULL");
  await putSlot(playerId, POCKETS, free, 1, hive.honey);
  await pool.query("UPDATE hives SET honey=0 WHERE id=$1", [hive.id]);
}

// ---- Shop ----

export async function ensureShop(playerId: number, nowMs: number) {
  const cycle = realCycle(nowMs);
  const r = await pool.query("SELECT * FROM shop_state WHERE player_id=$1", [playerId]);
  const shop = r.rows[0];
  const fresh = JSON.stringify([
    { item_id: 2, price: itemDef(2).buyPrice, qty: null },
    null,
    null,
    null,
  ]);
  if (!shop) {
    await pool.query("INSERT INTO shop_state(player_id, refresh_at, assortment) VALUES($1,$2,$3)", [
      playerId,
      (cycle + balance.shopRefreshCycles) * CYCLE + gameEpoch(),
      fresh,
    ]);
    return JSON.parse(fresh);
  }
  const refreshCycle = Math.floor((shop.refresh_at - gameEpoch()) / CYCLE);
  if (cycle >= refreshCycle) {
    await pool.query("UPDATE shop_state SET refresh_at=$1, assortment=$2 WHERE player_id=$3", [
      (cycle + balance.shopRefreshCycles) * CYCLE + gameEpoch(),
      fresh,
      playerId,
    ]);
    return JSON.parse(fresh);
  }
  return shop.assortment as (unknown | null)[];
}

function gameEpoch() {
  return game.worldEpoch;
}

export async function buy(playerId: number, shopSlot: number, nowMs: number) {
  const assortment = await ensureShop(playerId, nowMs);
  const entry = assortment[shopSlot];
  if (!entry) throw new GameError("EMPTY_SHOP_SLOT");
  const def = itemDef(entry.item_id);
  const p = await pool.query("SELECT coins FROM players WHERE id=$1", [playerId]);
  if (p.rows[0].coins < def.buyPrice!) throw new GameError("NO_COINS");
  const ok = await addItem(playerId, entry.item_id, 1);
  if (!ok) throw new GameError("POCKETS_FULL");
  await pool.query("UPDATE players SET coins=coins-$1 WHERE id=$2", [def.buyPrice, playerId]);
}

export async function sell(playerId: number, container: string, slot: number, nowMs: number) {
  // Selling is done in the shop screen from any player container slot.
  const s = await getSlot(playerId, container, slot);
  if (!s) throw new GameError("EMPTY_SOURCE");
  const def = itemDef(s.item_id);
  if (def.sellPrice === null) throw new GameError("NOT_SELLABLE");
  await pool.query("UPDATE players SET coins=coins+$1 WHERE id=$2", [def.sellPrice, playerId]);
  if (s.qty === 1) await clearSlot(playerId, container, slot);
  else await pool.query("UPDATE inventory_slots SET qty=qty-1 WHERE player_id=$1 AND container=$2 AND slot_index=$3", [playerId, container, slot]);
}

// ---- Merchant / repair ----

export async function merchant(playerId: number) {
  const p = await pool.query("SELECT hammer_claimed FROM players WHERE id=$1", [playerId]);
  if (p.rows[0].hammer_claimed) throw new GameError("ALREADY_CLAIMED");
  const ok = await addItem(playerId, 3, 1);
  if (!ok) throw new GameError("POCKETS_FULL");
  await pool.query("UPDATE players SET hammer_claimed=TRUE WHERE id=$1", [playerId]);
}

export async function useItem(playerId: number, container: string, slot: number, nowMs: number) {
  const s = await getSlot(playerId, container, slot);
  if (!s) throw new GameError("EMPTY_SOURCE");
  if (s.item_id !== 3) throw new GameError("NOT_USABLE");
  // repair hive: consume hammer + boards
  const hive = await getHive(playerId);
  if (hive.state === "working") throw new GameError("ALREADY_REPAIRED");
  const slots = await getSlots(playerId);
  const boards = slots.filter((x) => x.item_id === 2).reduce((a, x) => a + x.qty, 0);
  if (boards < balance.repairBoardsCost) throw new GameError("NO_BOARDS");
  let need = balance.repairBoardsCost;
  for (const x of slots.filter((x) => x.item_id === 2)) {
    const take = Math.min(need, x.qty);
    if (x.qty - take <= 0) await clearSlot(playerId, x.container, x.slot_index);
    else await pool.query("UPDATE inventory_slots SET qty=qty-$1 WHERE player_id=$2 AND container=$3 AND slot_index=$4", [take, playerId, x.container, x.slot_index]);
    need -= take;
    if (need <= 0) break;
  }
  await clearSlot(playerId, container, slot);
  await pool.query(
    "UPDATE hives SET state='working', bee_slot_count=1, last_prod_cycle=$1 WHERE id=$2",
    [realCycle(nowMs), hive.id]
  );
}

// ---- State assembly ----

export async function fullState(playerId: number, nowMs: number) {
  await updateProduction(playerId, nowMs);
  const p = await pool.query("SELECT * FROM players WHERE id=$1", [playerId]);
  const player = p.rows[0];
  const slots = await getSlots(playerId);
  const hive = await getHive(playerId);
  const assortment = await ensureShop(playerId, nowMs);
  const shopRow = await pool.query("SELECT refresh_at FROM shop_state WHERE player_id=$1", [playerId]);
  const wt = worldTime(nowMs, Number(player.time_offset), player.phase_override);
  const honeyTotal = slots
    .filter((s) => itemDef(s.item_id).tags.includes("мед"))
    .reduce((a, s) => a + s.qty, 0);
  return {
    player: { id: player.id, tgId: player.tg_id, coins: player.coins, adminMode: player.admin_mode },
    pocketsSlots: balance.pocketsSlots,
    storageSlots: balance.storageSlots,
    slots,
    hive: {
      state: hive.state,
      beeSlotCount: hive.bee_slot_count,
      honey: hive.honey,
      honeyCapacity: hive.honey_capacity,
      bees: hive.bees.map((b: any) => b.slot_index),
    },
    shop: { assortment, refreshAt: Number(shopRow.rows[0].refresh_at) },
    world: { ...wt, cycleLength: CYCLE, refreshCycles: balance.shopRefreshCycles },
    honeyTotal,
  };
}

export type FullState = Awaited<ReturnType<typeof fullState>>;
export { POCKETS, STORAGE };
