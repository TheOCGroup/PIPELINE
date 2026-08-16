FROM node:24-alpine AS builder

WORKDIR /usr/src/app

COPY package.json pnpm-lock.yaml ./

# Enable corepack and install dependencies
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
RUN pnpm install --prod --frozen-lockfile

FROM node:24-alpine AS runner

WORKDIR /usr/src/app

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/srv/ocg/ocg-one/data/ocg_one.db

# Create logs and data directory with secure permissions
RUN mkdir -p /srv/ocg/ocg-one/data /srv/ocg/ocg-one/logs && chown -R node:node /srv/ocg/ocg-one

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY . .

# Run as non-root node user
USER node

EXPOSE 8080

VOLUME ["/srv/ocg/ocg-one/data", "/srv/ocg/ocg-one/logs"]

CMD ["node", "server.js"]
