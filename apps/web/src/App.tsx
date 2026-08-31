import React, { useCallback, useEffect, useRef, useState } from "react";

// ---------- types ----------
type Slot = { container: "pockets" | "storage"; slot_index: number; item_id: number; qty: number };
type State = {
  player: { id: number; tgId: number; coins: number; adminMode: boolean };
  pocketsSlots: number;
  storageSlots: number;
  slots: Slot[];
  hive: { state: string; beeSlotCount: number; honey: number; honeyCapacity: number; bees: number[] };
  shop: { assortment: ({ item_id: number; price: number; qty: number | null } | null)[]; refreshAt: number };
  world: { cycle: number; phase: "day" | "night"; timeLeft: number; cycleLength: number; refreshCycles: number };
  honeyTotal: number;
};
type ItemDef = {
  id: number; name: string; tags: string[]; rarity: number; stack: number;
  buyPrice: number | null; sellPrice: number | null; uses: number | null; description: string;
};

const ITEM_DEFS: Record<number, ItemDef> = {
  1: { id: 1, name: "Дикий мед", tags: ["мед"], rarity: 0, stack: 40, buyPrice: null, sellPrice: 1, uses: null, description: "Мед из леса. Немного странный" },
  2: { id: 2, name: "Доски", tags: ["материал"], rarity: 0, stack: 20, buyPrice: 4, sellPrice: 2, uses: null, description: "Просто хорошие доски. Можно использовать много для чего" },
  3: { id: 3, name: "Старый молот", tags: ["инструмент"], rarity: 0, stack: 1, buyPrice: null, sellPrice: null, uses: 1, description: "Почувствую себя взрослым - сколоти скворечник!" },
  4: { id: 4, name: "Пчела", tags: ["пчела"], rarity: 0, stack: 1, buyPrice: null, sellPrice: null, uses: null, description: "Жужжит. Летит в лес за нектаром" },
};

const SCREEN_W = 422;
const SCREEN_H = 625;
const CYCLE = 10800;

// ---------- api ----------
async function api<T = State>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const initData = (window as any).Telegram?.WebApp?.initData || "";
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData, ...body }),
  });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.message || json.error), { code: json.error });
  return json;
}

function devId(): number | null {
  const m = new URLSearchParams(location.search).get("dev");
  return m ? Number(m) : null;
}

async function loadState(): Promise<State> {
  const d = devId();
  if (d) return api("/state", { devTgId: d });
  return api("/state");
}

// ---------- helpers ----------
const def = (id: number): ItemDef => ITEM_DEFS[id] ?? ITEM_DEFS[1];
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const fmtDays = (msLeft: number) => {
  const total = Math.max(0, Math.floor(msLeft / 1000));
  const days = Math.floor(total / CYCLE);
  const rem = total % CYCLE;
  return `${days} д (${Math.floor(rem / 3600)}:${String(Math.floor((rem % 3600) / 60)).padStart(2, "0")})`;
};

// ---------- popup ----------
type PopupData = {
  title: string;
  emoji: string;
  rarity: number;
  details: string;
  qty?: string;
  action?: { label: string; run: () => Promise<void> };
} | null;

// ---------- app ----------
export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [screen, setScreen] = useState<"menu" | "hive" | "storage" | "shop">("menu");
  const [popup, setPopup] = useState<PopupData>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const fetchedAt = useRef(Date.now());
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const [maintenance, setMaintenance] = useState(false);

  const apply = useCallback((s: State) => {
    setState(s);
    fetchedAt.current = Date.now();
  }, []);

  const run = useCallback(
    async (fn: () => Promise<State>) => {
      try {
        apply(await fn());
        setToast(null);
      } catch (e: any) {
        setToast(e.code === "MAINTENANCE" ? e.message : `Ошибка: ${e.code || e.message}`);
      }
    },
    [apply]
  );

  const refresh = useCallback(() => run(loadState), [run]);

  useEffect(() => {
    (async () => {
      try {
        apply(await loadState());
      } catch (e: any) {
        if (e.code === "MAINTENANCE") setMaintenance(true);
        else setToast(`Не удалось загрузиться: ${e.message}`);
      }
    })();
  }, [apply]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // swipe back (left -> right) from inner screens to menu
  const onTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touchStart.current;
    if (!s || screen === "menu") return;
    const dx = e.changedTouches[0].clientX - s.x;
    const dy = e.changedTouches[0].clientY - s.y;
    if (dx > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) setScreen("menu");
    touchStart.current = null;
  };

  if (maintenance)
    return (
      <Stage>
        <div className="center">🛠 Ведутся технические работы. Заходите позже!</div>
      </Stage>
    );
  if (!state)
    return (
      <Stage>
        <div className="center">{toast ?? "Загрузка..."}</div>
      </Stage>
    );

  const timeLeft = Math.max(0, state.world.timeLeft - Math.floor((now - fetchedAt.current) / 1000));
  const slotAt = (container: string, i: number) => state.slots.find((s) => s.container === container && s.slot_index === i);
  const shopRefreshLeft = state.shop.refreshAt > 0 ? state.shop.refreshAt - (Math.floor(now / 1000)) : 0;

  const openItemPopup = (slot: Slot, context: "hive" | "storage" | "shop") => {
    const d = def(slot.item_id);
    let action: PopupData extends null ? never : { label: string; run: () => Promise<State> } | undefined;
    action = undefined;
    if (context === "hive" && slot.container === "pockets" && slot.item_id === 4) {
      if (state.hive.state !== "working") action = { label: "Улей сломан", run: async () => state } as any;
      else if (state.hive.bees.length >= state.hive.beeSlotCount) action = { label: "Нет мест", run: async () => state } as any;
      else {
        const used = new Set(state.hive.bees);
        let free = 0;
        while (used.has(free)) free++;
        action = { label: "Поместить в улей", run: () => api("/hive/bee", { action: "place", slotIndex: free }) };
      }
    }
    if (context === "storage") {
      if (slot.item_id === 3 && state.hive.state === "broken") {
        action = { label: "Использовать (ремонт улья)", run: () => api("/use", { container: slot.container, slot: slot.slot_index }) };
      } else if (slot.container === "pockets") {
        const free = firstFree("storage");
        action = free === null ? undefined : { label: "На склад", run: () => api("/move", { from: { container: "pockets", slot: slot.slot_index }, to: { container: "storage", slot: free } }) };
      } else {
        const free = firstFree("pockets");
        action = free === null ? undefined : { label: "В карманы", run: () => api("/move", { from: { container: "storage", slot: slot.slot_index }, to: { container: "pockets", slot: free } }) };
      }
    }
    if (context === "shop" && d.sellPrice !== null) {
      action = { label: `Продать 1 шт (+${d.sellPrice} монет)`, run: () => api("/shop/sell", { container: slot.container, slot: slot.slot_index }) };
    }
    setPopup({
      title: d.name,
      emoji: emojiFor(d.id),
      rarity: d.rarity,
      details: d.description,
      qty: `${slot.qty}/${d.stack}`,
      action: action ? { label: action.label, run: async () => { try { apply(await action!.run()); setPopup(null); } catch (e: any) { setToast(`Ошибка: ${e.code}`); setPopup(null); } } } : undefined,
    });
  };

  const firstFree = (container: string): number | null => {
    const size = container === "pockets" ? state.pocketsSlots : state.storageSlots;
    const used = new Set(state.slots.filter((s) => s.container === container).map((s) => s.slot_index));
    for (let i = 0; i < size; i++) if (!used.has(i)) return i;
    return null;
  };

  const openBeeSlotPopup = (idx: number) => {
    if (state.hive.bees.includes(idx))
      setPopup({
        title: "Пчела", emoji: "🐝", rarity: 0,
        details: "Работает в улье. Извлечешь — процесс прервется.",
        qty: "1/1",
        action: { label: "Забрать пчелу", run: async () => { try { apply(await api("/hive/bee", { action: "remove", slotIndex: idx })); setPopup(null); } catch (e: any) { setToast(`Ошибка: ${e.code}`); setPopup(null); } } },
      });
    else setPopup({ title: "Пустая ячейка", emoji: "⬛", rarity: 0, details: "Слот для пчелы в улье." });
  };

  const openShopSlotPopup = (idx: number) => {
    const entry = state.shop.assortment[idx];
    if (!entry) return setPopup({ title: "Пусто", emoji: "⬛", rarity: 0, details: "Товара нет в наличии." });
    const d = def(entry.item_id);
    setPopup({
      title: d.name, emoji: emojiFor(d.id), rarity: d.rarity, details: d.description,
      action: {
        label: `Купить 1 шт (${entry.price} монет)`,
        run: async () => { try { apply(await api("/shop/buy", { slotIndex: idx })); setPopup(null); } catch (e: any) { setToast(`Ошибка: ${e.code}`); setPopup(null); } },
      },
    });
  };

  const clock = (
    <div className="chip" style={{ position: "absolute", top: 20, right: 20 }}>
      {state.world.phase === "day" ? "☀️ День" : "🌙 Ночь"} · {fmtTime(timeLeft)}
    </div>
  );

  const pocketsRow = (context: "hive" | "storage" | "shop", top: number) => (
    <div style={{ position: "absolute", top, left: 20, right: 20, display: "flex", gap: 10, justifyContent: "center" }}>
      {Array.from({ length: state.pocketsSlots }).map((_, i) => {
        const s = slotAt("pockets", i);
        return (
          <button key={i} className="cell yellow" onClick={() => s && openItemPopup(s, context)}>
            {s ? `${emojiFor(s.item_id)}${s.qty > 1 ? s.qty : ""}` : "＋"}
          </button>
        );
      })}
    </div>
  );

  return (
    <Stage>
      {screen === "menu" && (
        <>
          <div className="title">Buzzing Cure</div>
          <div className="chip" style={{ position: "absolute", top: 20, right: 20 }}>
            {state.world.phase === "day" ? "☀️ День" : "🌙 Ночь"} · {fmtTime(timeLeft)}
          </div>
          <button className="btn green" style={{ top: 130, left: 40 }} onClick={() => setScreen("shop")}>🛒 Магазин</button>
          <button className="btn yellow" style={{ top: 340, left: 40 }} onClick={() => setScreen("storage")}>📦 Склад</button>
          <button className="btn orange" style={{ top: 420, right: 40 }} onClick={() => setScreen("hive")}>🐝 Ульи</button>
          <div className="red-zone" style={{ position: "absolute", bottom: 30, left: 150, fontSize: 12, opacity: 0.5 }}>пусто</div>
        </>
      )}

      {screen === "hive" && (
        <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <div className="chip" style={{ position: "absolute", top: 20, left: 20 }}>🍯 Мёд: {state.honeyTotal}</div>
          {clock}
          <div style={{ position: "absolute", top: 150, left: 0, right: 0, textAlign: "center" }}>
            <div className="chip" style={{ display: "inline-block" }}>
              🍯 В улье: {state.hive.honey}/{state.hive.honeyCapacity}
            </div>
            <br />
            <button className="btn red" style={{ position: "static", marginTop: 10 }} onClick={() => run(() => api("/hive/collect"))}>
              Забрать мед
            </button>
          </div>
          <div style={{ position: "absolute", top: 300, left: 60, right: 60, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            {Array.from({ length: Math.max(state.hive.beeSlotCount, state.hive.state === "broken" ? 0 : state.hive.beeSlotCount) }).map((_, i) => (
              <button key={i} className="cell orange" onClick={() => openBeeSlotPopup(i)}>
                {state.hive.bees.includes(i) ? "🐝" : "⬛"}
              </button>
            ))}
          </div>
          {state.hive.state === "broken" && (
            <div style={{ position: "absolute", top: 310, left: 0, right: 0, textAlign: "center", color: "#f66" }}>
              Улей сломан — нужен ремонт
            </div>
          )}
          {pocketsRow("hive", 520)}
        </div>
      )}

      {screen === "storage" && (
        <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          {clock}
          <div className="chest" style={{ position: "absolute", top: 110, left: 40 }}>🧰</div>
          <div className="chip" style={{ position: "absolute", top: 140, left: 130 }}>
            Склад · занято {state.slots.filter((s) => s.container === "storage").length}/{state.storageSlots}
          </div>
          <div style={{ position: "absolute", top: 230, left: 50, right: 50, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 }}>
            {Array.from({ length: state.storageSlots }).map((_, i) => {
              const s = slotAt("storage", i);
              return (
                <button key={i} className="cell small yellow" onClick={() => s && openItemPopup(s, "storage")}>
                  {s ? `${emojiFor(s.item_id)}${s.qty > 1 ? s.qty : ""}` : "＋"}
                </button>
              );
            })}
          </div>
          {pocketsRow("storage", 525)}
        </div>
      )}

      {screen === "shop" && (
        <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <div className="chip" style={{ position: "absolute", top: 20, left: 20 }}>🪙 {state.player.coins}</div>
          {clock}
          <button className="seller" onClick={() => run(() => api("/merchant"))}>
            🧔‍♂️ Торговец<span className="seller-hint">нажми — получишь молот (1 раз)</span>
          </button>
          <div className="chip" style={{ position: "absolute", top: 150, right: 30 }}>
            Обновление: {fmtDays(shopRefreshLeft * 1000)}
          </div>
          <div style={{ position: "absolute", top: 300, left: 60, right: 60, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            {state.shop.assortment.map((entry, i) => (
              <button key={i} className="cell yellow" onClick={() => openShopSlotPopup(i)}>
                {entry ? `${emojiFor(entry.item_id)} ${entry.price}🪙` : "＋"}
              </button>
            ))}
          </div>
          {pocketsRow("shop", 525)}
        </div>
      )}

      {popup && (
        <div className="overlay" onClick={() => setPopup(null)}>
          <div className="popup" onClick={(e) => e.stopPropagation()}>
            <div className="popup-title">{popup.title}</div>
            <div className="popup-img">{popup.emoji}</div>
            <div className="popup-stars">{"⭐".repeat(Math.max(1, popup.rarity))}</div>
            <div className="popup-details">{popup.details}</div>
            {popup.qty && <div className="popup-qty">{popup.qty}</div>}
            {popup.action && <button className="btn green action" onClick={popup.action.run}>{popup.action.label}</button>}
            <button className="btn blue ok" onClick={() => setPopup(null)}>OK</button>
          </div>
        </div>
      )}
      {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
    </Stage>
  );
}

function emojiFor(id: number) {
  return ({ 1: "🍯", 2: "🪵", 3: "🔨", 4: "🐝" } as Record<number, string>)[id] ?? "❔";
}

function Stage({ children }: { children: React.ReactNode }) {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const f = () => setScale(Math.min(window.innerWidth / SCREEN_W, window.innerHeight / SCREEN_H));
    f();
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return (
    <div className="viewport">
      <div className="stage" style={{ width: SCREEN_W, height: SCREEN_H, transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}
