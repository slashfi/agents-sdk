FROM oven/bun:1.3 AS base
WORKDIR /app

# Install dependencies
COPY package.json ./
RUN bun install --production

# Copy source
COPY . .

EXPOSE 3000
CMD ["bun", "run", "server.ts"]
