# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && cp -R node_modules /tmp/prod_node_modules \
    && npm ci --ignore-scripts
COPY prisma ./prisma
# Generate the Postgres Prisma client (bundled into node_modules)
RUN npx prisma generate --schema=prisma/schema.postgresql.prisma

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

# Install curl for HEALTHCHECK
RUN apk add --no-cache curl tini

# Non-root user
RUN addgroup -g 10001 -S app && adduser -S -G app -u 10001 app

# Copy production node_modules and the Prisma client generated in the builder stage
COPY --from=builder /tmp/prod_node_modules ./node_modules
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

COPY --chown=app:app . .

USER app

EXPOSE 3000 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
