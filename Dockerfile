FROM oven/bun:1.3 AS base
WORKDIR /app

# Install SDK dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Build SDK
COPY src/ ./src/
COPY tsconfig.json ./

# Install example dependencies (uses the local SDK + query-builder)
COPY examples/cloud-db/package.json ./examples/cloud-db/
RUN cd examples/cloud-db && bun install --production

# Copy example source
COPY examples/cloud-db/ ./examples/cloud-db/

# Expose port
EXPOSE 3000

WORKDIR /app/examples/cloud-db
CMD ["bun", "run", "server.ts"]
