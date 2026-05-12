FROM node:24-alpine AS deps
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/schema/package.json packages/schema/package.json
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /repo

COPY --from=deps /repo/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY apps/api ./apps/api
COPY packages/schema ./packages/schema

RUN npm --workspace @claude-hub/schema run build
RUN npm --workspace @claude-hub/api run build

FROM node:24-alpine AS runner
WORKDIR /repo
ENV NODE_ENV=production

COPY --from=builder /repo/package.json /repo/package-lock.json ./
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/apps/api ./apps/api
COPY --from=builder /repo/packages/schema ./packages/schema

EXPOSE 8787
CMD ["npm", "--workspace", "@claude-hub/api", "run", "start"]
