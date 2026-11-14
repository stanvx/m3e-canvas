FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

ENV M3E_CHROME=/usr/bin/chromium \
    M3E_NO_SANDBOX=1 \
    NODE_ENV=production \
    PORT=3000 \
    M3E_HOST=0.0.0.0
EXPOSE 3000

CMD ["npx", "tsx", "mcp/server.ts"]
