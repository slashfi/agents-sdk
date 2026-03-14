import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./examples/databases/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
