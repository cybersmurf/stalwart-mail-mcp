# Remote mode: MCP over HTTP next to your Stalwart server (see docs/remote.md).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts && npm rebuild esbuild
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist/index.cjs ./dist/index.cjs
COPY LICENSE THIRD-PARTY-NOTICES.md ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8787/health >/dev/null || exit 1
CMD ["node", "dist/index.cjs", "--http"]
