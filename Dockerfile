FROM node:20-alpine

WORKDIR /app

# dependencies first for layer caching
COPY package.json package-lock.json* ./
RUN npm ci --only=production || npm install --only=production

COPY addon.js ./
COPY api ./api

ENV PORT=7000
EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7000/manifest.json || exit 1

CMD ["node", "addon.js"]
