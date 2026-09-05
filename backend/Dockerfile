FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src/ ./src/
# SQLite / upload data は PersistentVolume に置く
VOLUME ["/data"]
EXPOSE 3001
CMD ["node", "src/server.js"]
