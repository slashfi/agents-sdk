/**
 * JSONC Parser
 *
 * Parses JSON with comments (single-line and multi-line)
 * so agent.json files can be annotated.
 */

import { readFileSync } from "node:fs";

/**
 * Strip comments from JSONC content and parse as JSON.
 */
export function parseJsonc(content: string): unknown {
  let result = "";
  let i = 0;
  let inString = false;
  let stringChar = "";

  while (i < content.length) {
    if (inString) {
      if (content[i] === "\\" && i + 1 < content.length) {
        result += content[i] + content[i + 1];
        i += 2;
        continue;
      }
      if (content[i] === stringChar) {
        inString = false;
      }
      result += content[i];
      i++;
      continue;
    }

    if (content[i] === '"') {
      inString = true;
      stringChar = content[i];
      result += content[i];
      i++;
      continue;
    }

    // Single-line comment
    if (
      content[i] === "/" &&
      i + 1 < content.length &&
      content[i + 1] === "/"
    ) {
      while (i < content.length && content[i] !== "\n") i++;
      continue;
    }

    // Multi-line comment
    if (
      content[i] === "/" &&
      i + 1 < content.length &&
      content[i + 1] === "*"
    ) {
      i += 2;
      while (
        i + 1 < content.length &&
        !(content[i] === "*" && content[i + 1] === "/")
      )
        i++;
      i += 2;
      continue;
    }

    result += content[i];
    i++;
  }

  // Handle trailing commas
  const cleaned = result.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(cleaned);
}

/**
 * Read and parse a JSONC file.
 */
export function readJsoncFile(path: string): unknown {
  const content = readFileSync(path, "utf-8");
  return parseJsonc(content);
}
