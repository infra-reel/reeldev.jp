# ── Stage 1: ビルド (静的ファイルのみなのでコピーのみ) ──────────────────
FROM node:26.12.1-alpine AS deps
WORKDIR /app
COPY src/ ./

# ── Stage 2: Nginx serve ──────────────────────────────────────────────────
FROM nginx:1.27-alpine
COPY --from=builder /app /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
