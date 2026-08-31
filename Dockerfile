# ---- web build ----
FROM node:22-alpine AS web
WORKDIR /app
COPY apps/web/package.json ./
RUN npm install
COPY apps/web ./
RUN npm run build

# ---- runtime ----
FROM node:22-alpine
WORKDIR /app
COPY apps/server/package.json ./apps/server/
WORKDIR /app/apps/server
RUN npm install
COPY apps/server ./apps/server
COPY configs /app/configs
COPY --from=web /app/dist /app/apps/web/dist
WORKDIR /app/apps/server
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
