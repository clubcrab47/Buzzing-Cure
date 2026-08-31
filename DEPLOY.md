# Buzzing Cure — деплой на сервер (Docker + Telegram)

Полная инструкция, как поднять прототип на любом VPS (Ubuntu/Debian) и подключить к Telegram.

## 1. Подготовка сервера

```bash
# Docker + compose plugin
curl -fsSL https://get.docker.com | sh
```

## 2. Создание бота в Telegram

1. Открой @BotFather → `/newbot` → задай имя и username. Получишь **токен** вида `123456:ABC-...`.
2. (Для Mini App необязательно, но полезно) `/setmenubutton` → выбери бота → URL приложения → название кнопки.

## 3. Домен и HTTPS (обязателен для Mini App)

Telegram открывает Mini App только по **HTTPS**. Нужен домен (или бесплатный поддомен, например через DuckDNS).

Вариант А — **Caddy** (авто-HTTPS, проще всего). Положи рядом с проектом `Caddyfile`:

```
bc.example.com {
    reverse_proxy app:3000
}
```

и добавь в `docker-compose.yml` сервис:

```yaml
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
volumes:
  caddy_data:
```

(а у сервиса `app` строку `ports: ["3000:3000"]` можно убрать — наружу будет только Caddy).

Вариант Б — уже есть nginx/облако: просто проксируй HTTPS → `http://127.0.0.1:3000`.

## 4. Запуск

```bash
git clone <репозиторий> buzzing-cure && cd buzzing-cure   # или скопируй папку на сервер
cp .env.example .env
nano .env    # вписать BOT_TOKEN, WEBAPP_URL=https://bc.example.com, POSTGRES_PASSWORD
docker compose up -d --build
docker compose logs -f app   # дождаться "API+web on :3000" и "Bot started"
```

Проверка: `curl https://bc.example.com/api/health` → `{"ok":true}`.

## 5. Подключение Mini App к боту

1. В @BotFather: `/newapp` (или Bot Settings → Menu Button) → укажи `https://bc.example.com`.
2. Открой бота → кнопка «Открыть игру» / `/start` с кнопкой.
3. Добавь себя в админы: `configs/admins.json` → `"admins": ["ТВОЙ_TG_ID"]` (узнать ID: `/id`), затем `docker compose restart app`.

## 6. Проверка геймплея (ручной сценарий)

1. Открыл игру → в кармане пчела, 8 монет, улей сломан.
2. Магазин → торговец → получил молот. Купил 2 доски по 4 монеты (осталось 0).
3. Склад → popup на молоте → «Использовать» → улей починен, 1 слот, молот и доски исчезли.
4. Экран «Ульи» → popup на пчеле → «Поместить в улей».
5. `/admin`, затем `/set night` и `/skip 1` (или подождать цикл 3 ч) → в улье появился мед.
6. «Забрать мед» → мед в карманах. Магазин → popup на меде → «Продать».
7. `/player` — выход из админ-режима.

## Полезное

- Обновить код: `git pull && docker compose up -d --build`
- Логи: `docker compose logs -f app`
- БД: `docker compose exec db psql -U bc buzzing`
- Полный сброс данных: `docker compose down -v` (удалит и базу!)
