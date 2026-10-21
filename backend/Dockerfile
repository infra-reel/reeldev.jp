FROM node:26.12.1-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
# SQLite / upload data は PersistentVolume に置く
VOLUME ["/data"]
EXPOSE 3001
CMD ["node", "src/server.js"]
