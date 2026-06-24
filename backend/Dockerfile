FROM node:22-slim AS builder

ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-slim

RUN apt-get update \
    && apt-get install -y chromium --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY . .

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/api/scrape',{method:'POST',headers:{'Content-Type':'application/json'}},r=>process.exit(r.statusCode===400?0:1)).on('error',()=>process.exit(1))"

USER node

CMD ["node", "--max-old-space-size=256", "server.js"]
