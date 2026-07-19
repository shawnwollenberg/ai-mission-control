FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/require-node22.mjs ./scripts/require-node22.mjs
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nextjs \
    && mkdir -p /app/.mission-control/events \
    && chown -R nextjs:nodejs /app/.mission-control
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/app/icon.png ./app/icon.png
COPY --from=builder --chown=nextjs:nodejs /app/fixtures ./fixtures
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/tsx ./node_modules/tsx
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/esbuild ./node_modules/esbuild
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@esbuild ./node_modules/@esbuild
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/bcryptjs ./node_modules/bcryptjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/lib ./lib
COPY --from=builder --chown=nextjs:nodejs /app/application ./application
COPY --from=builder --chown=nextjs:nodejs /app/domain ./domain
COPY --from=builder --chown=nextjs:nodejs /app/templates ./templates
COPY --from=builder --chown=nextjs:nodejs /app/policy ./policy
COPY --from=builder --chown=nextjs:nodejs /app/execution ./execution
COPY --from=builder --chown=nextjs:nodejs /app/git ./git
COPY --from=builder --chown=nextjs:nodejs /app/db ./db
COPY --from=builder --chown=nextjs:nodejs /app/agents ./agents
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
