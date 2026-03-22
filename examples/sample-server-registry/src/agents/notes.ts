/**
 * @notes agent
 *
 * Demonstrates a stateful agent with in-memory CRUD.
 * Tools: create_note, list_notes, get_note, delete_note
 */

import { defineAgent, defineTool, type ToolDefinition } from "@slashfi/agents-sdk";

interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: string;
}

// In-memory store (swap for a real DB in production)
const notes = new Map<string, Note>();
let nextId = 1;

const createNote = defineTool({
  name: "create_note",
  description: "Create a new note",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Note title" },
      content: { type: "string", description: "Note content" },
    },
    required: ["title", "content"],
  },
  execute: async (input: { title: string; content: string }) => {
    const id = `note_${nextId++}`;
    const note: Note = {
      id,
      title: input.title,
      content: input.content,
      createdAt: new Date().toISOString(),
    };
    notes.set(id, note);
    return { success: true, note };
  },
});

const listNotes = defineTool({
  name: "list_notes",
  description: "List all notes",
  inputSchema: {
    type: "object",
    properties: {},
  },
  execute: async () => {
    return {
      count: notes.size,
      notes: Array.from(notes.values()).map((n) => ({
        id: n.id,
        title: n.title,
        createdAt: n.createdAt,
      })),
    };
  },
});

const getNote = defineTool({
  name: "get_note",
  description: "Get a note by ID",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Note ID" },
    },
    required: ["id"],
  },
  execute: async (input: { id: string }) => {
    const note = notes.get(input.id);
    if (!note) return { error: `Note not found: ${input.id}` };
    return { note };
  },
});

const deleteNote = defineTool({
  name: "delete_note",
  description: "Delete a note by ID",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Note ID" },
    },
    required: ["id"],
  },
  execute: async (input: { id: string }) => {
    const existed = notes.delete(input.id);
    return { success: existed, id: input.id };
  },
});

export const notesAgent = defineAgent({
  path: "@notes",
  entrypoint: "You manage notes. You can create, list, read, and delete notes.",
  config: {
    name: "Notes",
    description: "Simple note-taking service",
  },
  tools: [createNote, listNotes, getNote, deleteNote] as ToolDefinition[],
  visibility: "internal", // Requires auth
});
