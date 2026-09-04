# ── Stage 1: ビルド (静的ファイルのみなのでコピーのみ) ──────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY src/ ./

# ── Stage 2: Nginx serve ──────────────────────────────────────────────────
FROM nginx:1.27-alpine
COPY --from=builder /app /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
