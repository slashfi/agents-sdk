/**
 * @weather agent
 *
 * Demonstrates a simple agent that wraps an external API.
 * Tools: get_weather, get_forecast
 */

import { defineAgent, defineTool, type ToolDefinition } from "@slashfi/agents-sdk";

// Fake weather data (replace with real API calls)
const CITIES: Record<string, { temp: number; condition: string; humidity: number }> = {
  "san francisco": { temp: 62, condition: "foggy", humidity: 78 },
  "new york": { temp: 45, condition: "cloudy", humidity: 55 },
  "miami": { temp: 82, condition: "sunny", humidity: 70 },
  "seattle": { temp: 48, condition: "rainy", humidity: 85 },
  "austin": { temp: 75, condition: "sunny", humidity: 40 },
};

const getWeather = defineTool({
  name: "get_weather",
  description: "Get current weather for a city",
  visibility: "public",
  inputSchema: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: "City name (e.g., 'san francisco')",
      },
    },
    required: ["city"],
  },
  execute: async (input: { city: string }) => {
    const data = CITIES[input.city.toLowerCase()];
    if (!data) {
      return { error: `Unknown city: ${input.city}. Try: ${Object.keys(CITIES).join(", ")}` };
    }
    return {
      city: input.city,
      temperature: `${data.temp}°F`,
      condition: data.condition,
      humidity: `${data.humidity}%`,
    };
  },
});

const getForecast = defineTool({
  name: "get_forecast",
  description: "Get a 3-day forecast for a city",
  visibility: "public",
  inputSchema: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: "City name",
      },
    },
    required: ["city"],
  },
  execute: async (input: { city: string }) => {
    const data = CITIES[input.city.toLowerCase()];
    if (!data) {
      return { error: `Unknown city: ${input.city}` };
    }
    // Generate fake forecast from base data
    return {
      city: input.city,
      forecast: [
        { day: "today", temp: data.temp, condition: data.condition },
        { day: "tomorrow", temp: data.temp + Math.round(Math.random() * 10 - 5), condition: "partly cloudy" },
        { day: "day after", temp: data.temp + Math.round(Math.random() * 10 - 5), condition: "clear" },
      ],
    };
  },
});

export const weatherAgent = defineAgent({
  path: "@weather",
  entrypoint: "You provide weather information for cities.",
  config: {
    name: "Weather",
    description: "Current weather and forecasts",
  },
  tools: [getWeather, getForecast] as ToolDefinition[],
  visibility: "public",
});
