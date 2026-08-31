# HANDOFF — Buzzing Cure v0.5

Дата: 31.08.2026. Этап: прототип реализован полностью (этапы 1–18 плана одним заходом), ожидает деплоя и ручной проверки пользователя.

## Что это
Telegram Mini App игра: пчела → ремонт улья → цикл день/ночь → мед → склад/магазин → монеты.

## Зафиксированные game rules (решения пользователя, 31.08.2026)
1. Лимит продажи (cap) — **убран полностью**, нет и счетчиков продаж.
2. Refresh магазина — **раз в 3 игровых цикла (9 ч)**, персональный у каждого игрока.
3. Ассортимент — персональный: слот 0 = доски (4 монеты), слоты 1–3 пустые.
4. Карманы — **4 слота, общие для всех экранов**.
5. Пчела, помещенная посреди дня/ночи — **все равно получает мед** за завершившийся цикл (упрощение, доработать при необходимости).
6. Старый молот — одноразовая выдача (флаг `hammer_claimed`), использование тратит молот + 2 доски.
7. Улей один, модель с `hive_index` — задел на несколько.
8. Монеты — `players.coins`, не предмет.
9. Хранение — PostgreSQL; конфиги — JSON (`configs/`).
10. Тесты — автоматические gameplay-тесты не пишутся; tsc/build использовались как техпроверка.
11. `/skip` — локальный `time_offset` игрока (глобальная эпоха не трогается); `/set day|night` — персональный `phase_override`, `/set normal` снимает.
12. `/adminreset` — снапшот всего состояния игрока на момент `/admin`, откат только его данных.

## Стек
- Frontend: React 18 + TypeScript + Vite (`apps/web`), stage 422×625 масштабируется под окно.
- Backend: Fastify + TypeScript (`apps/server`), запускается через tsx; раздает статику `apps/web/dist`.
- Bot: grammY, long polling, тот же процесс.
- DB: PostgreSQL 16, драйвер `pg`, схема создается автоматически при старте (`db.ts initDb`).
- Докер: `Dockerfile` (multi-stage: сборка web → рантайм), `docker-compose.yml` (db + app).

## Структура
```
buzzing-cure/
├── apps/web/          # React UI (App.tsx — все экраны + popup)
├── apps/server/src/
│   ├── index.ts       # Fastify, /api/* маршруты
│   ├── bot.ts         # все Telegram-команды
│   ├── game.ts        # инвентарь (move/merge/swap), улей, магазин, состояние
│   ├── world.ts       # эпоха/циклы/фазы + ленивое производство меда
│   ├── auth.ts        # валидация initData + создание игрока (старт: пчела, 8 монет, сломан. улей)
│   ├── config.ts, db.ts
├── configs/           # game.json (worldEpoch, day/night), balance.json, items.json, admins.json
├── Dockerfile, docker-compose.yml, .env.example, DEPLOY.md
```

## Модель данных (таблицы)
`players` (tg_id, coins, time_offset, phase_override, hammer_claimed, admin_mode), `inventory_slots` (player_id, container='pockets'|'storage', slot_index, item_id, qty), `hives` (state broken/working, bee_slot_count, honey, honey_capacity=6, last_prod_cycle), `hive_bee_slots` (наличие пчелы в слоте), `shop_state` (refresh_at, assortment JSON), `admin_snapshots`, `globals` (maintenance).

## Время
worldEpoch=1767225600 (2026-01-01 UTC), DAY=7200s, NIGHT=3600s, CYCLE=10800s. Фаза вычисляется из `now - worldEpoch`; персональные offset/override — только для отображения и симуляции админа. Производство ленивое: при любом чтении состояния `updateProduction` добавляет `bees × завершенные циклы`, cap 6, `last_prod_cycle` всегда продвигается (без задолженности).

## API (POST, тело содержит initData)
`/state`, `/move` {from{container,slot}, to{...}}, `/hive/bee` {action: place|remove, slotIndex}, `/hive/collect`, `/shop/buy` {slotIndex}, `/shop/sell` {container, slot}, `/merchant`, `/use` {container, slot}. Ошибки: `{error: CODE}` (POCKETS_FULL, NO_COINS, HIVE_BROKEN, ALREADY_CLAIMED, MAINTENANCE...). `/api/health` — GET.
Dev-режим без Telegram: `{devTgId: N}` или открыть web с `?dev=1`.

## Предметы (items.json)
1 Дикий мед (продажа 1), 2 Доски (покупка 4, продажа 2, стак 20), 3 Старый молот (uses 1), 4 Пчела (id добавлен, т.к. пчела в кармане должна быть предметом).

## Бот-команды
/id, /admin (снапшот+вход), /player, /adminreset, /reset, /item <тег>, /give [uid] <item> <amt>, /info [uid], /edit [uid] coins|honey|time_offset <val>, /skip <n>, /set day|night|normal, /server start|shutdown.

## Известные упрощения / ограничения
- Перемещение через popup идет в первый свободный слот; swap между конкретными занятыми слотами реализован на сервере (`/move`), но в UI не выведен.
- Извлечение пчелы не сбрасывает ничего (производство считается по улью, решение №5 выше).
- Изображения предметов — эмодзи-заглушки; дизайн отложен по ТЗ.
- Сборка web в Docker строит Vite из apps/web/dist копией в образ.
- Runtime-прогон в контейнере не выполнялся локально (на машине нет Docker) — проверяется на деплое по DEPLOY.md.

## Последний завершенный этап
Этапы 1–18 (каркас → админка → debug time → reset → maintenance). Next: деплой по DEPLOY.md, ручной сценарий из раздела 6, затем правки по замечаниям.
