FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
# dist/scripts (the Lua files) comes along with this — `npm run build` copies
# them, so a plain local `npm run build && npm start` works the same way the
# image does, instead of only ever being correct inside Docker.
COPY --from=build /app/dist ./dist

# Run as the unprivileged user the base image already provides. A gateway is
# the process most exposed to untrusted input in this whole system, so it's
# the last one that should be running as root inside its container.
USER node

EXPOSE 8080

# Liveness only — deliberately not /ready, which reports 503 while Redis is
# unreachable. Restarting the container over that would defeat the fail-open
# design: the gateway is built to keep serving through a Redis outage.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
