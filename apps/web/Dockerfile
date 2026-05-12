FROM node:24-alpine AS deps
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/schema/package.json packages/schema/package.json
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /repo/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY apps/web ./apps/web
COPY packages/schema ./packages/schema

RUN npm --workspace @claude-hub/schema run build
RUN npm --workspace @claude-hub/web run build

FROM node:24-alpine AS runner
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

COPY --from=builder /repo/package.json /repo/package-lock.json ./
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/apps/web ./apps/web
COPY --from=builder /repo/packages/schema ./packages/schema

EXPOSE 3000
CMD ["npm", "--workspace", "@claude-hub/web", "run", "start"]
