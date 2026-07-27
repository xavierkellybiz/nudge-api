# Nudge backend — deploys anywhere (Render / Railway / Fly.io / any container host).
# Secrets come from the host's env vars, NOT baked into the image.
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Copy only the source we need (never the .env or logs).
COPY index.js menu-engine.js ./
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "index.js"]
