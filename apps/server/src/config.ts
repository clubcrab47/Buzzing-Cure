import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const ROOT = root;

export const game = JSON.parse(readFileSync(path.join(root, "configs/game.json"), "utf8"));
export const balance = JSON.parse(readFileSync(path.join(root, "configs/balance.json"), "utf8"));
export const itemsConfig = JSON.parse(readFileSync(path.join(root, "configs/items.json"), "utf8"));
export const adminsConfig = JSON.parse(readFileSync(path.join(root, "configs/admins.json"), "utf8"));

export type ItemDef = {
  id: number;
  name: string;
  tags: string[];
  rarity: number;
  stack: number;
  buyPrice: number | null;
  sellPrice: number | null;
  uses: number | null;
  description: string;
};

export const ITEMS: Map<number, ItemDef> = new Map(
  itemsConfig.items.map((i: ItemDef) => [i.id, i])
);
export const itemDef = (id: number): ItemDef => {
  const d = ITEMS.get(id);
  if (!d) throw new Error(`unknown item ${id}`);
  return d;
};

export const CYCLE = game.daySeconds + game.nightSeconds;
export const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
export const WEBAPP_URL = process.env.WEBAPP_URL ?? "";
export const PORT = Number(process.env.PORT ?? 3000);
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://bc:bc@localhost:5432/buzzing";
