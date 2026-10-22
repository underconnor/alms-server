/** Server-internal authorization. Never include these identifiers in tool arguments or results. */
export interface McpPrincipal {
  readonly userId: string;
  readonly authorizationId: string;
  readonly sessionTokenHash: string;
  readonly scopes: readonly string[];
  validate(signal?: AbortSignal): Promise<void>;
}

export interface McpReadToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

export interface McpReadToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpReadTools {
  listToolDefinitions(): McpReadToolDefinition[];
  call(name: string, args: unknown, principal: McpPrincipal, options: { signal: AbortSignal }): Promise<McpReadToolResult>;
}
