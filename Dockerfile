FROM oven/bun:1.3 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ ./src/
COPY examples/ ./examples/
COPY tsconfig.json ./

# Expose port
EXPOSE 3000

# Start the database agent server
CMD ["bun", "run", "examples/databases/server.ts"]
