/**
 * Types for Agent Registration System
 */

// Re-export Network from main types
export type { Network } from '../types.js';

/**
 * Agent configuration from agent.json
 */
export interface AgentConfig {
  label: string;
  description: string;
  endpoint: string;
  actions_required: string[];
  input_schema?: Record<string, unknown>;
  uses_agents?: Array<{
    stage: string;
    agent_id: string;
  }>;
}

/**
 * Network-specific configuration in the central registry
 */
export interface NetworkRegistryConfig {
  agent_home: string;
  deploying_user_prefix: string;
  created_at: string;
}

/**
 * Central registry file (agents.registry.json)
 * Stored at repo root, shared across all agents
 */
export interface AgentsRegistry {
  test?: NetworkRegistryConfig;
  main?: NetworkRegistryConfig;
}

/**
 * Network-specific agent state
 */
export interface NetworkAgentState {
  agent_id: string;
  agent_key_prefix: string;
  agent_home: string;
  registered_at: string;
  updated_at: string;
  endpoint: string;
  /** ISO timestamp when endpoint was verified */
  endpoint_verified_at?: string;
}

/**
 * Per-service state file (.agent-state.json)
 */
export interface AgentState {
  test?: NetworkAgentState;
  main?: NetworkAgentState;
}

/**
 * Per-service keys file (.agent-keys.json)
 */
export interface AgentKeys {
  test?: string;
  main?: string;
}

/**
 * Options for the registration function
 */
export interface RegisterOptions {
  /** Working directory (defaults to process.cwd()) */
  cwd?: string;
  /** Whether to register on production network */
  production?: boolean;
  /** Override the API URL */
  apiUrl?: string;
  /** Override the user API key */
  userKey?: string;
  /** Override the agent home collection ID */
  agentHome?: string;
  /** Whether to skip auto-pushing to wrangler secrets (default: false) */
  skipSecretPush?: boolean;
  /** Cloudflare account ID for wrangler operations */
  cloudflareAccountId?: string;
}

/**
 * Result of a successful registration
 */
export interface RegisterResult {
  agentId: string;
  agentKeyPrefix: string;
  agentHome: string;
  network: 'test' | 'main';
  isNew: boolean;
  secretPushed: boolean;
}

/**
 * API response types
 */
export interface ArkeAgent {
  id: string;
  cid: string;
  properties: {
    label: string;
    description: string;
    endpoint: string;
  };
  status: string;
}

export interface ArkeCollection {
  id: string;
  cid: string;
}

export interface ArkeApiKey {
  key: string;
  prefix: string;
}

/**
 * Response from POST /agents/{id}/verify (token generation)
 */
export interface VerifyTokenResponse {
  verification_token: string;
  agent_id: string;
  endpoint: string;
  instructions: string;
  expires_at: string;
}

/**
 * Response from POST /agents/{id}/verify with confirm: true
 */
export interface VerifyResultResponse {
  verified: boolean;
  verified_at?: string;
  error?: string;
}
