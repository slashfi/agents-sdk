import type { Config } from "@slashfi/query-builder/lib/introspection/config.js";

export default {
  database: {
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 26257),
    schema: "public",
    user: process.env.DB_USER ?? "app",
    password: process.env.DB_PASSWORD ?? "",
    ssl: false,
    database: process.env.DB_NAME ?? "defaultdb",
  },

  patterns: ["./db/schema.ts"],
  migrationsDir: "migrations",
} satisfies Config;
