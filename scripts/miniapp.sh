#!/bin/bash
# Поднимает бесплатный HTTPS-адрес (trycloudflare) и прописывает его кнопкой в бота.
# Запускать из папки проекта. Требует BOT_TOKEN в .env рядом.
set -e
cd "$(dirname "$0")/.."
if [ -f .env ]; then export $(grep -v '^#' .env | xargs); fi
if [ -z "$BOT_TOKEN" ]; then echo "BOT_TOKEN не найден в .env"; exit 1; fi

apt-get install -y -qq cloudflared curl jq >/dev/null 2>&1 || true

LOG=/tmp/bctunnel.log
rm -f $LOG
nohup cloudflared tunnel --url http://localhost:3000 > $LOG 2>&1 &
echo "Ждем адрес от cloudflare..."
URL=""
for i in $(seq 1 30); do
  sleep 2
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' $LOG | head -1)
  [ -n "$URL" ] && break
done
[ -z "$URL" ] && { echo "Не удалось получить адрес, смотри $LOG"; exit 1; }

curl -s "https://api.telegram.org/bot$BOT_TOKEN/setChatMenuButton" \
  -H 'Content-Type: application/json' \
  -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"🐝 Играть\",\"web_app\":{\"url\":\"$URL\"}}}" >/dev/null

echo ""
echo "=========================================="
echo " Mini App доступен по адресу: $URL"
echo " Кнопка 'Играть' добавлена боту в Telegram."
echo " ВАЖНО: адрес меняется при перезапуске скрипта —"
echo " просто запусти его снова, он обновит кнопку."
echo "=========================================="
wait
