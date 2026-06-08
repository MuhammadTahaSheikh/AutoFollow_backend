FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache wget

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5000/api/health || exit 1

USER node

CMD ["node", "src/server.js"]
