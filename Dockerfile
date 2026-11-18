# Ktemia MCP server (Node build) for the Docker MCP Catalog.
# Builds the same code that is published to npm as @ktemia/mcp, from source.
# Runs over stdio. Needs KTEMIA_API_KEY at runtime (not at build time).

FROM node:22-alpine AS build
WORKDIR /app/typescript
COPY typescript/package.json typescript/package-lock.json ./
RUN npm ci --ignore-scripts
COPY spec/ /app/spec/
COPY typescript/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/typescript
COPY --from=build /app/typescript/package.json ./
COPY --from=build /app/typescript/node_modules ./node_modules
COPY --from=build /app/typescript/dist ./dist
USER node
ENTRYPOINT ["node", "dist/index.js"]
