import { getConfiguredServerTargets } from '@src/config/configuredServerTargets.js';
import { TemplateHashProvider } from '@src/core/server/connectionResolver.js';
import { OutboundConnections } from '@src/core/types/index.js';
import logger, { errorIf } from '@src/logger/logger.js';
import type { Tool } from '@src/sdk/contracts/index.js';
import { zodToInputSchema, zodToOutputSchema } from '@src/utils/schemaUtils.js';

import { CapabilityCatalog } from './capabilityCatalog.js';
import { getCapabilityVisibleServerNames, type CapabilityVisibility } from './capabilityVisibility.js';
import { SchemaCache } from './schemaCache.js';
import {
  ToolInstructionsInputSchema,
  ToolInstructionsOutput,
  ToolInstructionsOutputSchema,
  ToolInvokeInputSchema,
  ToolInvokeOutput,
  ToolInvokeOutputSchema,
  ToolListInputSchema,
  ToolListOutput,
  ToolListOutputSchema,
  ToolSchemaInputSchema,
  ToolSchemaOutput,
  ToolSchemaOutputSchema,
} from './schemas/metaToolSchemas.js';
import { type ToolMetadata, ToolRegistry } from './toolRegistry.js';

/**
 * Result types for meta-tools
 */
export type GetInstructionsResult = ToolInstructionsOutput;
export type ListToolsResult = ToolListOutput;
export type DescribeToolResult = ToolSchemaOutput;
export type CallToolResult = ToolInvokeOutput;

/**
 * Function to load tool schema from upstream server
 */
export type SchemaLoader = (server: string, toolName: string) => Promise<Tool>;
export type ServerInstructionsProvider = (server: string) => string | undefined;

/**
 * Arguments for tool_list
 */
export interface ListAvailableToolsArgs {
  server?: string;
  pattern?: string;
  tag?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Arguments for tool_instructions
 */
export interface GetInstructionsArgs {
  server?: string;
}

/**
 * Arguments for tool_schema
 */
export interface DescribeToolArgs {
  server: string;
  toolName: string;
}

/**
 * Arguments for tool_invoke
 */
export interface CallToolArgs {
  server: string;
  toolName: string;
  args: unknown;
}

/**
 * Function to get the current tool registry
 * This allows the provider to always have access to the latest registry
 */
export type ToolRegistryProvider = () => ToolRegistry;

/**
 * MetaToolProvider provides meta-tools for lazy loading:
 * 1. tool_instructions - Explain lazy discovery and visible downstream servers
 * 2. tool_list - List all tools (names + descriptions only)
 * 3. tool_schema - Get full tool schema on-demand
 * 4. tool_invoke - Invoke any tool by server and name
 *
 * @example
 * ```typescript
 * const provider = new MetaToolProvider(() => toolRegistry, schemaCache, outboundConnections, loadSchemaFn);
 * const tools = provider.getMetaTools();
 * const result = await provider.callMetaTool('tool_list', { server: 'filesystem' });
 * ```
 */
export class MetaToolProvider {
  private getToolRegistry: ToolRegistryProvider;
  private schemaCache: SchemaCache;
  private outboundConnections: OutboundConnections;
  private loadSchema?: SchemaLoader;
  private defaultVisibility?: CapabilityVisibility;
  private capabilityCatalog: CapabilityCatalog;
  private templateHashProvider?: TemplateHashProvider;
  private serverInstructionsProvider?: ServerInstructionsProvider;

  constructor(
    getToolRegistry: ToolRegistryProvider,
    schemaCache: SchemaCache,
    outboundConnections: OutboundConnections,
    loadSchema?: SchemaLoader,
    defaultVisibility?: CapabilityVisibility,
    templateHashProvider?: TemplateHashProvider,
    serverInstructionsProvider?: ServerInstructionsProvider,
  ) {
    this.getToolRegistry = getToolRegistry;
    this.schemaCache = schemaCache;
    this.outboundConnections = outboundConnections;
    this.loadSchema = loadSchema;
    this.defaultVisibility = defaultVisibility;
    this.templateHashProvider = templateHashProvider;
    this.serverInstructionsProvider = serverInstructionsProvider;
    this.capabilityCatalog = new CapabilityCatalog({
      getToolRegistry,
      schemaCache,
      outboundConnections,
      loadSchema,
      defaultVisibility,
      templateHashProvider,
      getServerConfigs: getConfiguredServerTargets,
    });
  }

  public setServerInstructionsProvider(provider?: ServerInstructionsProvider): void {
    this.serverInstructionsProvider = provider;
  }

  /**
   * Set the default capability visibility for callers without request context.
   */
  public setCapabilityVisibility(visibility?: CapabilityVisibility): void {
    this.defaultVisibility = visibility;
    this.capabilityCatalog = new CapabilityCatalog({
      getToolRegistry: this.getToolRegistry,
      schemaCache: this.schemaCache,
      outboundConnections: this.outboundConnections,
      loadSchema: this.loadSchema,
      defaultVisibility: visibility,
      templateHashProvider: this.templateHashProvider,
      getServerConfigs: getConfiguredServerTargets,
    });
  }

  /**
   * Get all available meta-tools.
   */
  public getMetaTools(): Tool[] {
    return [
      this.createInstructionsMetaTool(),
      this.createListToolsMetaTool(),
      this.createDescribeToolMetaTool(),
      this.createCallToolMetaTool(),
    ];
  }

  /**
   * Call a meta-tool by name
   */
  public async callMetaTool(
    name: string,
    args: unknown,
    visibility?: CapabilityVisibility,
  ): Promise<GetInstructionsResult | ListToolsResult | DescribeToolResult | CallToolResult> {
    switch (name) {
      case 'tool_instructions': {
        const parsed = ToolInstructionsInputSchema.safeParse(args);
        if (!parsed.success) {
          return {
            mode: 'metatool',
            instructions: '',
            servers: [],
            totalTools: 0,
            error: {
              type: 'validation',
              message: `Invalid arguments for tool_instructions: ${parsed.error.message}`,
            },
          } as GetInstructionsResult;
        }
        return this.getInstructions(parsed.data, visibility);
      }
      case 'tool_list': {
        const parsed = ToolListInputSchema.safeParse(args);
        if (!parsed.success) {
          return {
            tools: [],
            totalCount: 0,
            servers: [],
            hasMore: false,
            error: {
              type: 'validation',
              message: `Invalid arguments for tool_list: ${parsed.error.message}`,
            },
          } as ListToolsResult;
        }
        return this.listAvailableTools(parsed.data, visibility);
      }
      case 'tool_schema': {
        const parsed = ToolSchemaInputSchema.safeParse(args);
        if (!parsed.success) {
          return {
            schema: {},
            error: {
              type: 'validation',
              message: `Invalid arguments for tool_schema: ${parsed.error.message}`,
            },
          } as DescribeToolResult;
        }
        return this.describeTool(parsed.data, visibility);
      }
      case 'tool_invoke': {
        const parsed = ToolInvokeInputSchema.safeParse(args);
        if (!parsed.success) {
          return {
            result: {},
            server: '',
            tool: '',
            error: {
              type: 'validation',
              message: `Invalid arguments for tool_invoke: ${parsed.error.message}`,
            },
          } as CallToolResult;
        }
        return this.callTool(parsed.data, visibility);
      }
      default:
        return {
          tools: [],
          totalCount: 0,
          servers: [],
          hasMore: false,
          error: {
            type: 'not_found',
            message:
              `Unknown meta-tool: ${name}. Valid meta-tools are: ` +
              'tool_instructions, tool_list, tool_schema, tool_invoke',
          },
        } as ListToolsResult;
    }
  }

  private createInstructionsMetaTool(): Tool {
    return {
      name: 'tool_instructions',
      description:
        'Get instructions for using 1MCP lazy discovery and the visible downstream server namespace. ' +
        "Call without arguments for the gateway playbook and server summary, or pass server to include that server's instructions.",
      inputSchema: zodToInputSchema(ToolInstructionsInputSchema) as Tool['inputSchema'],
      outputSchema: zodToOutputSchema(ToolInstructionsOutputSchema) as Tool['outputSchema'],
    };
  }

  private getInstructions(args: GetInstructionsArgs, visibility?: CapabilityVisibility): GetInstructionsResult {
    const registry = this.getToolRegistry();
    const visibleServerNames = visibility
      ? getCapabilityVisibleServerNames(visibility)
      : new Set(registry.getServers());
    const availableServers = registry.getServers().filter((server) => visibleServerNames.has(server));

    if (args.server && !availableServers.includes(args.server)) {
      return {
        mode: 'metatool',
        instructions: this.getLazyDiscoveryInstructions(),
        servers: [],
        totalTools: 0,
        error: {
          type: 'not_found',
          message: `Server not found or not visible: ${args.server}`,
        },
      };
    }

    const selectedServers = args.server ? [args.server] : availableServers;
    const toolCounts = registry.getToolCountByServer();
    const servers = selectedServers.map((name) => {
      const instructions = this.serverInstructionsProvider?.(name)?.trim();
      return {
        name,
        toolCount: toolCounts[name] ?? 0,
        hasInstructions: !!instructions,
        ...(args.server && instructions ? { instructions } : {}),
      };
    });

    return {
      mode: 'metatool',
      instructions: this.getLazyDiscoveryInstructions(),
      servers,
      totalTools: servers.reduce((sum, server) => sum + server.toolCount, 0),
    };
  }

  private getLazyDiscoveryInstructions(): string {
    return [
      'Use tool_list to discover downstream tools.',
      'The server parameter means a downstream 1MCP server name returned by tool_list; do not use the outer gateway name.',
      'The pattern parameter is an anchored glob over tool names. Use *term* for substring matching, for example *browser*.',
      'A filtered zero result only means those filters matched nothing. Retry tool_list({ limit: 20 }) without server or pattern before diagnosing a gateway or server failure.',
      'Treat server and tool names returned by tool_list as authoritative.',
      'Call tool_schema before the first tool_invoke for a tool so arguments are validated against the current schema.',
    ].join('\n');
  }

  /**
   * Create the tool_list meta-tool
   */
  private createListToolsMetaTool(): Tool {
    return {
      name: 'tool_list',
      description: 'List all available MCP tools with names and descriptions. Use for tool discovery.',
      inputSchema: zodToInputSchema(ToolListInputSchema) as Tool['inputSchema'],
      outputSchema: zodToOutputSchema(ToolListOutputSchema) as Tool['outputSchema'],
    };
  }

  /**
   * Implement tool_list
   */
  private async listAvailableTools(
    args: ListAvailableToolsArgs,
    visibility?: CapabilityVisibility,
  ): Promise<ListToolsResult> {
    try {
      const result = await this.capabilityCatalog.listVisibleTools(args, visibility);

      // Format tools for response
      const tools = result.tools.map((tool: ToolMetadata) => ({
        name: tool.name,
        server: tool.server,
        description: tool.description,
        tags: tool.tags,
      }));

      // Get unique servers from filtered results to keep output consistent with applied filters
      const servers = Array.from(new Set(result.tools.map((t) => t.server))).sort();

      // Return structured result matching outputSchema
      const response: ListToolsResult = {
        tools,
        totalCount: result.totalCount,
        servers,
        hasMore: result.hasMore,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errorIf(() => ({
        message: 'Error in tool_list meta-tool',
        meta: { args, error: errorMessage },
      }));

      return {
        tools: [],
        totalCount: 0,
        servers: [],
        hasMore: false,
        error: {
          type: 'internal',
          message: `Internal error listing tools: ${errorMessage}`,
        },
      };
    }
  }

  /**
   * Create the tool_schema meta-tool
   */
  private createDescribeToolMetaTool(): Tool {
    return {
      name: 'tool_schema',
      description: 'Get the full schema for a specific tool including input validation rules',
      inputSchema: zodToInputSchema(ToolSchemaInputSchema) as Tool['inputSchema'],
      outputSchema: zodToOutputSchema(ToolSchemaOutputSchema) as Tool['outputSchema'],
    };
  }

  /**
   * Implement tool_schema
   */
  private async describeTool(args: DescribeToolArgs, visibility?: CapabilityVisibility): Promise<DescribeToolResult> {
    try {
      const result = await this.capabilityCatalog.describeVisibleTool(args, visibility);
      if (result.error) {
        return {
          schema: {},
          error: result.error,
        };
      }

      return {
        schema: result.schema as unknown as Record<string, unknown>,
        fromCache: result.fromCache,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errorIf(() => ({
        message: 'Error in tool_schema meta-tool',
        meta: { server: args.server, toolName: args.toolName, error: errorMessage },
      }));

      return {
        schema: {},
        error: {
          type: 'internal',
          message: `Internal error describing tool: ${errorMessage}`,
        },
      };
    }
  }

  /**
   * Create the tool_invoke meta-tool
   */
  private createCallToolMetaTool(): Tool {
    return {
      name: 'tool_invoke',
      description: 'Execute any tool on any MCP server with proper argument validation',
      inputSchema: zodToInputSchema(ToolInvokeInputSchema) as Tool['inputSchema'],
      outputSchema: zodToOutputSchema(ToolInvokeOutputSchema) as Tool['outputSchema'],
    };
  }

  /**
   * Implement tool_invoke
   */
  private async callTool(args: CallToolArgs, visibility?: CapabilityVisibility): Promise<CallToolResult> {
    try {
      const result = await this.capabilityCatalog.invokeVisibleTool(args, visibility);
      if (result.error) {
        return {
          result: {},
          server: args.server,
          tool: args.toolName,
          error: result.error,
        };
      }

      return {
        result: result.result as Record<string, unknown>,
        server: result.server,
        tool: result.tool,
      };
    } catch (error) {
      logger.error(`Error in tool_invoke: ${error}`);

      // Check if it's a tool not found error from upstream
      if (error instanceof Error && error.message.includes('not found')) {
        return {
          result: {},
          server: args.server,
          tool: args.toolName,
          error: {
            type: 'not_found',
            message: `Tool not found: ${args.server}:${args.toolName}`,
          },
        };
      }

      return {
        result: {},
        server: args.server,
        tool: args.toolName,
        error: {
          type: 'upstream',
          message: `Server Error: ${error}. This is an upstream server issue - please report it.`,
        },
      };
    }
  }
}
