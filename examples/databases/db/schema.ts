import { pgTable, text, integer, timestamp, boolean, serial, numeric, varchar } from "drizzle-orm/pg-core";

// ============================================
// Auth Tables
// ============================================

export const authClients = pgTable("auth_clients", {
  clientId: text("client_id").primaryKey(),
  clientSecretHash: text("client_secret_hash").notNull(),
  name: text("name").notNull(),
  scopes: text("scopes").array().notNull().default([]),
  selfRegistered: boolean("self_registered").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const authTokens = pgTable("auth_tokens", {
  token: text("token").primaryKey(),
  clientId: text("client_id").notNull().references(() => authClients.clientId, { onDelete: "cascade" }),
  scopes: text("scopes").array().notNull().default([]),
  issuedAt: timestamp("issued_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

// ============================================
// Demo Tables
// ============================================

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  category: varchar("category", { length: 50 }).notNull(),
});
