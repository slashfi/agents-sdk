/**
 * Seed demo data into Postgres.
 * Idempotent - safe to run multiple times.
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { users, orders, products } from "./schema.js";
import { sql } from "drizzle-orm";

export async function seed(db: PostgresJsDatabase) {
  // Check if already seeded
  const existing = await db.select().from(users).limit(1);
  if (existing.length > 0) {
    console.log("[seed] Data already exists, skipping.");
    return;
  }

  console.log("[seed] Seeding demo data...");

  // Users
  await db.insert(users).values([
    { name: "Alice Johnson", email: "alice@example.com" },
    { name: "Bob Smith", email: "bob@example.com" },
    { name: "Charlie Brown", email: "charlie@example.com" },
    { name: "Diana Prince", email: "diana@example.com" },
    { name: "Eve Wilson", email: "eve@example.com" },
  ]);

  // Products
  await db.insert(products).values([
    { name: "Widget Pro", price: "29.99", category: "tools" },
    { name: "Gadget X", price: "99.99", category: "electronics" },
    { name: "Thingamajig", price: "149.50", category: "electronics" },
    { name: "Doohickey", price: "14.99", category: "accessories" },
    { name: "Whatchamacallit", price: "49.99", category: "tools" },
  ]);

  // Orders
  await db.insert(orders).values([
    { userId: 1, amount: "99.99", status: "completed" },
    { userId: 2, amount: "149.50", status: "pending" },
    { userId: 1, amount: "29.99", status: "completed" },
    { userId: 3, amount: "200.00", status: "cancelled" },
    { userId: 4, amount: "49.99", status: "completed" },
    { userId: 5, amount: "14.99", status: "pending" },
    { userId: 2, amount: "99.99", status: "completed" },
    { userId: 3, amount: "29.99", status: "completed" },
  ]);

  console.log("[seed] Done. Seeded 5 users, 5 products, 8 orders.");
}
