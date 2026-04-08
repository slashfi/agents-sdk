/**
 * Basic Example
 *
 * Demonstrates creating an agent with tools and starting a server.
 *
 * Run with: bun examples/basic.ts
 */

import {
  defineAgent,
  defineTool,
  createAgentRegistry,
  createAgentServer,
} from '../src/index.js';

// ============================================
// Define Tools
// ============================================

const greet = defineTool({
  name: 'greet',
  description: 'Greet a user by name',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the person to greet',
      },
    },
    required: ['name'],
  },
  execute: async (input: { name: string }) => {
    return {
      message: `Hello, ${input.name}!`,
      timestamp: new Date().toISOString(),
    };
  },
});

const echo = defineTool({
  name: 'echo',
  description: 'Echo back a message',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Message to echo',
      },
    },
    required: ['message'],
  },
  execute: async (input: { message: string }) => {
    return {
      echo: input.message,
      length: input.message.length,
    };
  },
});

const calculate = defineTool({
  name: 'calculate',
  description: 'Perform basic arithmetic',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['add', 'subtract', 'multiply', 'divide'],
        description: 'The arithmetic operation to perform',
      },
      a: {
        type: 'number',
        description: 'First operand',
      },
      b: {
        type: 'number',
        description: 'Second operand',
      },
    },
    required: ['operation', 'a', 'b'],
  },
  execute: async (input: { operation: string; a: number; b: number }) => {
    let result: number;
    switch (input.operation) {
      case 'add':
        result = input.a + input.b;
        break;
      case 'subtract':
        result = input.a - input.b;
        break;
      case 'multiply':
        result = input.a * input.b;
        break;
      case 'divide':
        if (input.b === 0) {
          throw new Error('Cannot divide by zero');
        }
        result = input.a / input.b;
        break;
      default:
        throw new Error(`Unknown operation: ${input.operation}`);
    }
    return {
      expression: `${input.a} ${input.operation} ${input.b}`,
      result,
    };
  },
});

// ============================================
// Define Agent
// ============================================

const agent = defineAgent({
  path: '@example',
  entrypoint: `You are a helpful assistant with access to several tools.

You can:
- Greet users by name
- Echo messages back
- Perform basic arithmetic

Be friendly and helpful!`,
  config: {
    id: 'example',
    name: 'Example Agent',
    description: 'A simple example agent demonstrating the SDK',
    supportedActions: ['execute_tool', 'describe_tools', 'load'],
  },
  tools: [greet, echo, calculate],
  visibility: 'public', // Allow unauthenticated access
});

// ============================================
// Create Registry and Server
// ============================================

const registry = createAgentRegistry();
registry.register(agent);

const server = createAgentServer(registry, {
  port: 3000,
  hostname: 'localhost',
});

await server.start();

console.log('\nTry these commands:');
console.log(
  '  curl http://localhost:3000/agents'
);
console.log(
  '  curl -X POST http://localhost:3000/call -H "Content-Type: application/json" -d \'{"action":"execute_tool","path":"@example","tool":"greet","params":{"name":"World"}}\''
);
console.log(
  '  curl -X POST http://localhost:3000/call -H "Content-Type: application/json" -d \'{"action":"describe_tools","path":"@example"}\'' 
);
