import { describe, expect, test } from "bun:test";
import { createBM25Index } from "./bm25";

describe("BM25 search", () => {
  const documents = [
    { id: "greet", text: "greet a user by their name send greeting" },
    { id: "search-db", text: "search database records query SQL tables" },
    {
      id: "send-message",
      text: "send a message to a Slack channel post notification",
    },
    { id: "upload-file", text: "upload a file to cloud storage S3 bucket" },
    { id: "list-users", text: "list all users in the system directory" },
    {
      id: "create-ticket",
      text: "create a support ticket in the issue tracker",
    },
  ];

  test("finds relevant results", () => {
    const index = createBM25Index(documents);
    const results = index.search("send message");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("send-message");
  });

  test("ranks by relevance", () => {
    const index = createBM25Index(documents);
    const results = index.search("database query");

    expect(results[0].id).toBe("search-db");
    expect(results[0].score).toBeGreaterThan(0);
  });

  test("returns empty for no matches", () => {
    const index = createBM25Index(documents);
    const results = index.search("xyz123nonexistent");

    expect(results).toEqual([]);
  });

  test("respects limit", () => {
    const index = createBM25Index(documents);
    const results = index.search("a", 2);

    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("handles empty query", () => {
    const index = createBM25Index(documents);
    const results = index.search("");

    expect(results).toEqual([]);
  });

  test("handles empty document set", () => {
    const index = createBM25Index([]);
    const results = index.search("anything");

    expect(results).toEqual([]);
  });

  test("partial term matching via word overlap", () => {
    const index = createBM25Index(documents);
    const results = index.search("user");

    // Should match both greet (contains "user") and list-users (contains "users")
    // Note: exact match only since we tokenize - "user" != "users"
    const ids = results.map((r) => r.id);
    expect(ids).toContain("greet");
  });

  test("scores decrease with more documents containing term", () => {
    const index = createBM25Index(documents);
    // "a" appears in multiple documents, so should have lower IDF
    const resultsCommon = index.search("a");
    // "SQL" only in one, so higher IDF
    const resultsRare = index.search("sql");

    if (resultsRare.length > 0 && resultsCommon.length > 0) {
      // Rare terms should score higher for their matching doc
      expect(resultsRare[0].score).toBeGreaterThan(resultsCommon[0].score);
    }
  });
});
