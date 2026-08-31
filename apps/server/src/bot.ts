import { Bot, InlineKeyboard } from "grammy";
import { BOT_TOKEN, WEBAPP_URL, CYCLE, ITEMS, itemDef } from "./config.js";
import { pool, getGlobal, setGlobal } from "./db.js";
import { ensurePlayer } from "./auth.js";

function isAdmin(tgId: number, admins: string[]) {
  return admins.map(Number).includes(tgId);
}

async function loadAdmins(): Promise<string[]> {
  const { adminsConfig } = await import("./config.js");
  return adminsConfig.admins ?? [];
}

async function snapshotPlayer(playerId: number) {
  const p = await pool.query("SELECT * FROM players WHERE id=$1", [playerId]);
  const slots = await pool.query("SELECT * FROM inventory_slots WHERE player_id=$1", [playerId]);
  const hives = await pool.query("SELECT * FROM hives WHERE player_id=$1", [playerId]);
  const bees = await pool.query(
    "SELECT b.* FROM hive_bee_slots b JOIN hives h ON h.id=b.hive_id WHERE h.player_id=$1",
    [playerId]
  );
  const shop = await pool.query("SELECT * FROM shop_state WHERE player_id=$1", [playerId]);
  return { player: p.rows[0], slots: slots.rows, hives: hives.rows, bees: bees.rows, shop: shop.rows[0] ?? null };
}

async function restoreSnapshot(playerId: number, snap: any) {
  await pool.query("BEGIN");
  try {
    await pool.query("DELETE FROM hive_bee_slots WHERE hive_id IN (SELECT id FROM hives WHERE player_id=$1)", [playerId]);
    await pool.query("DELETE FROM hives WHERE player_id=$1", [playerId]);
    await pool.query("DELETE FROM inventory_slots WHERE player_id=$1", [playerId]);
    await pool.query("DELETE FROM shop_state WHERE player_id=$1", [playerId]);
    await pool.query("UPDATE players SET coins=$1, hammer_claimed=$2, time_offset=$3, phase_override=$4 WHERE id=$5", [
      snap.player.coins, snap.player.hammer_claimed, snap.player.time_offset, snap.player.phase_override, playerId,
    ]);
    for (const s of snap.slots)
      await pool.query("INSERT INTO inventory_slots(player_id,container,slot_index,item_id,qty) VALUES($1,$2,$3,$4,$5)", [playerId, s.container, s.slot_index, s.item_id, s.qty]);
    for (const h of snap.hives) {
      const r = await pool.query(
        "INSERT INTO hives(player_id,hive_index,state,level,bee_slot_count,honey,honey_capacity,last_prod_cycle) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [playerId, h.hive_index, h.state, h.level, h.bee_slot_count, h.honey, h.honey_capacity, h.last_prod_cycle]
      );
      for (const b of snap.bees.filter((x: any) => x.hive_id === h.id))
        await pool.query("INSERT INTO hive_bee_slots(hive_id,slot_index,placed_cycle) VALUES($1,$2,$3)", [r.rows[0].id, b.slot_index, b.placed_cycle]);
    }
    if (snap.shop)
      await pool.query("INSERT INTO shop_state(player_id,refresh_at,assortment) VALUES($1,$2,$3)", [playerId, snap.shop.refresh_at, snap.shop.assortment]);
    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }
}

export async function startBot() {
  const bot = new Bot(BOT_TOKEN);
  const admins = await loadAdmins();

  const findPlayer = async (tgId?: number) => {
    if (tgId) {
      const r = await pool.query("SELECT * FROM players WHERE tg_id=$1", [tgId]);
      return r.rows[0] ?? null;
    }
    return null;
  };

  bot.command("start", async (ctx) => {
    const kb = new InlineKeyboard();
    if (WEBAPP_URL) kb.url("🐝 Открыть игру", WEBAPP_URL);
    await ctx.reply("Buzzing Cure — добро пожаловать!", kb ? { reply_markup: kb } : undefined);
  });

  bot.command("id", (ctx) => ctx.reply(`Твой Telegram ID: ${ctx.from?.id}`));

  bot.command("admin", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id, admins)) return ctx.reply("Нет доступа.");
    const player = await ensurePlayer({ id: ctx.from.id, name: ctx.from.first_name ?? String(ctx.from.id) });
    const snap = await snapshotPlayer(player.id);
    await pool.query(
      "INSERT INTO admin_snapshots(player_id, data) VALUES($1,$2) ON CONFLICT(player_id) DO UPDATE SET data=$2, created_at=now()",
      [player.id, JSON.stringify(snap)]
    );
    await pool.query("UPDATE players SET admin_mode=TRUE WHERE id=$1", [player.id]);
    await ctx.reply(
      "Режим администратора включен. Данные сохранены в точку отклика.\n" +
        "Команды: /player /adminreset /reset /item <тег> /give [uid] <item> <amt> /info [uid] /edit <uid> <field> <value> /skip <n> /set day|night|normal /server start|shutdown"
    );
  });

  bot.command("player", async (ctx) => {
    if (!ctx.from) return;
    await pool.query("UPDATE players SET admin_mode=FALSE WHERE tg_id=$1", [ctx.from.id]);
    ctx.reply("Выход из режима администратора.");
  });

  bot.command("adminreset", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id, admins)) return;
    const p = await pool.query("SELECT id FROM players WHERE tg_id=$1", [ctx.from.id]);
    if (!p.rows.length) return ctx.reply("Игрок не найден.");
    const s = await pool.query("SELECT data FROM admin_snapshots WHERE player_id=$1", [p.rows[0].id]);
    if (!s.rows.length) return ctx.reply("Снапшот не найден. Сначала /admin.");
    await restoreSnapshot(p.rows[0].id, s.rows[0].data);
    ctx.reply("Возврат к точке сохранения выполнен.");
  });

  bot.command("reset", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id, admins)) return;
    const p = await pool.query("SELECT id FROM players WHERE tg_id=$1", [ctx.from.id]);
    if (p.rows.length) {
      await pool.query("DELETE FROM players WHERE id=$1", [p.rows[0].id]);
      await pool.query("DELETE FROM admin_snapshots WHERE player_id=$1", [p.rows[0].id]);
    }
    ctx.reply("Все данные сброшены. Открой Mini App, чтобы создать игрока заново.");
  });

  bot.command("item", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id, admins)) return;
    const tag = (ctx.match || "").trim();
    const list = [...ITEMS.values()].filter((i) => !tag || i.tags.includes(tag));
    ctx.reply(list.map((i) => `#${i.id} ${i.name} [${i.tags.join(",")}]`).join("\n") || "Ничего не найдено.");
  });

  bot.command("give", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id, admins)) return;
    const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return ctx.reply("Формат: /give [user id] <item id> <amount>");
    let uid: number | undefined, itemId: number, amount: number;
    if (parts.length === 3) [itemId, amount] = parts.map(Number) as [number, number];
    else [uid, itemId, amount] = parts.map(Number) as [number, number, number];
    const target = uid ? await findPlayer(uid) : await findPlayer(ctx.from.id);
    if (!target) return ctx.reply("Игрок не найден (должен хотя бы раз открыть игру).");
    try {
      const def = itemDef(itemId);
      // give directly into pockets/storage via addItem
      const { addItem } = await import("./game.js");
      const ok = await addItem(target.id, def.id, amount);
      ctx.reply(ok ? `Выдано: ${def.name} x${amount}` : "Инвентарь получателя полон.");
    } catch {
      ctx.reply("Неизвестный item id.");
    }
  });

  bot.command("info", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id, admins)) return;
    const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
    const target = parts[0] ? await findPlayer(Number(parts[0])) : await findPlayer(ctx.from.id);
    if (!target) return ctx.reply("Игрок не найден.");
    const snap = await snapshotPlayer(target.id);
    ctx.reply(`<pre>${JSON.stringify(snap, null, 1).replace(/</g, "&lt;")}</pre>`, { parse_mode: "HTML" });
  });

  bot.command("edit", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id, admins)) return;
    const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
    // /edit <field> <value>  |  /edit <uid> <field> <value>
    let target, field, value;
    if (parts.length === 2) [field, value] = parts;
    else [target, field, value] = parts;
    const player = target ? await findPlayer(Number(target)) : await findPlayer(ctx.from.id);
    if (!player) return ctx.reply("Игрок не найден.");
    const allowed = ["coins", "honey", "time_offset"];
    if (!allowed.includes(field!)) return ctx.reply(`Поля: ${allowed.join(", ")}`);
    if (field === "coins") await pool.query("UPDATE players SET coins=$1 WHERE id=$2", [Number(value), player.id]);
    if (field === "honey") await pool.query("UPDATE hives SET honey=$1 WHERE player_id=$2", [Number(value), player.id]);
    if (field === "time_offset") await pool.query("UPDATE players SET time_offset=$1 WHERE id=$2", [Number(value), player.id]);
    ctx.reply("Изменено.");
  });

  bot.command("skip", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id, admins)) return;
    const n = Number(ctx.match.trim());
    if (!n || n <= 0) return ctx.reply("Формат: /skip <число циклов>");
    await pool.query("UPDATE players SET time_offset = time_offset + $1 WHERE tg_id=$2", [n * CYCLE, ctx.from.id]);
    ctx.reply(`Локальная симуляция: пропущено ${n} циклов (глобальное время не тронуто).`);
  });

  bot.command("set", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id, admins)) return;
    const v = ctx.match.trim();
    if (!["day", "night", "normal"].includes(v)) return ctx.reply("Формат: /set day|night|normal");
    await pool.query("UPDATE players SET phase_override=$1 WHERE tg_id=$2", [v === "normal" ? null : v, ctx.from.id]);
    ctx.reply(`Фаза установлена: ${v} (только для тебя).`);
  });

  bot.command("server", async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id, admins)) return;
    const v = ctx.match.trim();
    if (v === "shutdown") {
      await setGlobal("maintenance", true);
      ctx.reply("Сервер переведен в режим техработ.");
    } else if (v === "start") {
      await setGlobal("maintenance", false);
      ctx.reply("Сервер запущен.");
    } else ctx.reply("Формат: /server start|shutdown");
  });

  bot.catch((err) => console.error("bot error", err));
  bot.start({ drop_pending_updates: true });
}
