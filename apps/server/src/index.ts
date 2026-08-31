import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { initDb, pool, getGlobal } from "./db.js";
import { validateInitData, ensurePlayer } from "./auth.js";
import * as g from "./game.js";
import { GameError } from "./game.js";
import { PORT, ROOT } from "./config.js";
import { startBot } from "./bot.js";

const app = Fastify({ logger: false });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof GameError) reply.code(400).send({ error: err.code, message: err.message });
  else {
    console.error(err);
    reply.code(500).send({ error: "INTERNAL" });
  }
});

type Body = { initData?: string; devTgId?: number };

async function playerFrom(req: any) {
  const maintenance = await getGlobal<boolean>("maintenance");
  if (maintenance) throw new GameError("MAINTENANCE", "Ведутся технические работы");
  let tg = null;
  if (req.body?.initData) tg = validateInitData(req.body.initData);
  else if (req.body?.devTgId) tg = { id: Number(req.body.devTgId), name: "Dev" + req.body.devTgId };
  if (!tg) throw new GameError("UNAUTHORIZED");
  return ensurePlayer(tg);
}

app.post("/api/state", async (req) => {
  const player = await playerFrom(req);
  return g.fullState(player.id, Date.now());
});
app.post("/api/move", async (req) => {
  const player = await playerFrom(req);
  const b = req.body as any;
  return g.move(player.id, b.from.container, b.from.slot, b.to.container, b.to.slot);
});
app.post("/api/hive/bee", async (req) => {
  const player = await playerFrom(req);
  const b = req.body as any;
  if (b.action === "place") await g.placeBee(player.id, b.slotIndex, Date.now());
  else await g.removeBee(player.id, b.slotIndex);
  return g.fullState(player.id, Date.now());
});
app.post("/api/hive/collect", async (req) => {
  const player = await playerFrom(req);
  await g.collectHoney(player.id);
  return g.fullState(player.id, Date.now());
});
app.post("/api/shop/buy", async (req) => {
  const player = await playerFrom(req);
  await g.buy(player.id, (req.body as any).slotIndex, Date.now());
  return g.fullState(player.id, Date.now());
});
app.post("/api/shop/sell", async (req) => {
  const player = await playerFrom(req);
  const b = req.body as any;
  await g.sell(player.id, b.container, b.slot, Date.now());
  return g.fullState(player.id, Date.now());
});
app.post("/api/merchant", async (req) => {
  const player = await playerFrom(req);
  await g.merchant(player.id);
  return g.fullState(player.id, Date.now());
});
app.post("/api/use", async (req) => {
  const player = await playerFrom(req);
  const b = req.body as any;
  await g.useItem(player.id, b.container, b.slot, Date.now());
  return g.fullState(player.id, Date.now());
});

// health for container orchestration
app.get("/api/health", async () => {
  await pool.query("SELECT 1");
  return { ok: true };
});

async function main() {
  await initDb();
  const webDist = path.join(ROOT, "apps/web/dist");
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith("/api")) return reply.code(404).send({ error: "NOT_FOUND" });
    return reply.sendFile("index.html");
  });
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`API+web on :${PORT}`);
  if (process.env.BOT_TOKEN) {
    await startBot();
    console.log("Bot started (polling)");
  } else {
    console.log("BOT_TOKEN not set — bot disabled");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
