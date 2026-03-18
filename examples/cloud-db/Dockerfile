FROM oven/bun:1.3 AS base
WORKDIR /app

# Install dependencies (cache bust: v0.2.0-mcp)
COPY package.json ./
RUN bun install --production

# Copy source
COPY . .

EXPOSE 3000
CMD ["bun", "run", "server.ts"]
