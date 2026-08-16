FROM node:24-alpine AS builder

WORKDIR /usr/src/app

COPY package.json pnpm-lock.yaml ./

# Enable corepack and install production dependencies
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
RUN pnpm install --prod --frozen-lockfile

FROM node:24-alpine AS runner

WORKDIR /usr/src/app

ENV NODE_ENV=production
ENV PORT=8090
ENV PIPELINE_DB_PATH=/data/pipeline.db

# Create logs and data directory with secure non-root permissions
RUN mkdir -p /data /logs && chown -R node:node /data /logs

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY . .

# Run as non-root node user
USER node

EXPOSE 8090

VOLUME ["/data", "/logs"]

CMD ["node", "server.js"]
