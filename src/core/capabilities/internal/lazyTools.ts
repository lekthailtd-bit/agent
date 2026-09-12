import type { Tool } from '@src/sdk/contracts/index.js';
import { zodToInputSchema, zodToOutputSchema } from '@src/utils/schemaUtils.js';

import {
  ToolInstructionsInputSchema,
  ToolInstructionsOutputSchema,
  ToolInvokeInputSchema,
  ToolInvokeOutputSchema,
  ToolListInputSchema,
  ToolListOutputSchema,
  ToolSchemaInputSchema,
  ToolSchemaOutputSchema,
} from '../schemas/metaToolSchemas.js';

/**
 * Lazy loading discovery tools
 * These tools provide on-demand access to the full tool registry
 */

export function createToolInstructionsTool(): Tool {
  return {
    name: 'tool_instructions',
    description:
      'Get instructions for using 1MCP lazy discovery and the visible downstream server namespace. ' +
      "Call without arguments for the gateway playbook and server summary, or pass server to include that server's instructions.",
    inputSchema: zodToInputSchema(ToolInstructionsInputSchema) as Tool['inputSchema'],
    outputSchema: zodToOutputSchema(ToolInstructionsOutputSchema) as Tool['outputSchema'],
    annotations: {
      title: 'Get 1MCP Instructions',
      readOnlyHint: true,
      openWorldHint: false,
    },
  };
}

export function createToolListTool(): Tool {
  return {
    name: 'tool_list',
    description: 'List all available MCP tools with names and descriptions. Use for tool discovery.',
    inputSchema: zodToInputSchema(ToolListInputSchema) as Tool['inputSchema'],
    outputSchema: zodToOutputSchema(ToolListOutputSchema) as Tool['outputSchema'],
    annotations: {
      title: 'List Available Tools',
      readOnlyHint: true,
      openWorldHint: false,
    },
  };
}

export function createToolSchemaTool(): Tool {
  return {
    name: 'tool_schema',
    description: 'Get the full schema for a specific tool including input validation rules',
    inputSchema: zodToInputSchema(ToolSchemaInputSchema) as Tool['inputSchema'],
    outputSchema: zodToOutputSchema(ToolSchemaOutputSchema) as Tool['outputSchema'],
    annotations: {
      title: 'Get Tool Schema',
      readOnlyHint: true,
      openWorldHint: false,
    },
  };
}

export function createToolInvokeTool(): Tool {
  return {
    name: 'tool_invoke',
    description: 'Execute any tool on any MCP server with proper argument validation',
    inputSchema: zodToInputSchema(ToolInvokeInputSchema) as Tool['inputSchema'],
    outputSchema: zodToOutputSchema(ToolInvokeOutputSchema) as Tool['outputSchema'],
    annotations: {
      title: 'Invoke Tool',
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

export const LAZY_TOOLS = ['tool_instructions', 'tool_list', 'tool_schema', 'tool_invoke'] as const;
export type LazyToolName = (typeof LAZY_TOOLS)[number];
