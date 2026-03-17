FROM oven/bun:1.3 AS base
WORKDIR /app

# Install SDK dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Build SDK
COPY src/ ./src/
COPY tsconfig.json ./

# Install example dependencies (uses the local SDK + query-builder)
COPY examples/registry/package.json ./examples/registry/
RUN cd examples/registry && bun install --production

# Copy example source
COPY examples/registry/ ./examples/registry/

# Expose port
EXPOSE 3000

WORKDIR /app/examples/registry
CMD ["bun", "run", "server.ts"]
