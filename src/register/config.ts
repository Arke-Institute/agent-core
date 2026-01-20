/**
 * Configuration file management for agent registration
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Network } from '../types.js';
import type {
  AgentConfig,
  AgentsRegistry,
  AgentState,
  AgentKeys,
  NetworkRegistryConfig,
  NetworkAgentState,
} from './types.js';

const REGISTRY_FILE = 'agents.registry.json';
const STATE_FILE = '.agent-state.json';
const KEYS_FILE = '.agent-keys.json';
const AGENT_CONFIG_FILE = 'agent.json';
const ENV_FILE = '.env.test';

/**
 * Find the repository root by looking for .git directory
 */
export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('Could not find repository root (no .git directory found)');
}

/**
 * Load the central agents registry from repo root
 */
export function loadRegistry(repoRoot: string): AgentsRegistry {
  const registryPath = path.join(repoRoot, REGISTRY_FILE);
  if (!fs.existsSync(registryPath)) {
    return {};
  }
  const content = fs.readFileSync(registryPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Save the central agents registry to repo root
 */
export function saveRegistry(repoRoot: string, registry: AgentsRegistry): void {
  const registryPath = path.join(repoRoot, REGISTRY_FILE);
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
}

/**
 * Get or create registry config for a network
 */
export function getOrCreateNetworkRegistry(
  repoRoot: string,
  network: Network,
  agentHome: string,
  userKeyPrefix: string
): NetworkRegistryConfig {
  const registry = loadRegistry(repoRoot);

  if (registry[network]) {
    return registry[network];
  }

  const config: NetworkRegistryConfig = {
    agent_home: agentHome,
    deploying_user_prefix: userKeyPrefix,
    created_at: new Date().toISOString(),
  };

  registry[network] = config;
  saveRegistry(repoRoot, registry);

  return config;
}

/**
 * Load service-specific agent state
 */
export function loadAgentState(serviceDir: string): AgentState {
  const statePath = path.join(serviceDir, STATE_FILE);
  if (!fs.existsSync(statePath)) {
    return {};
  }
  const content = fs.readFileSync(statePath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Save service-specific agent state
 */
export function saveAgentState(serviceDir: string, state: AgentState): void {
  const statePath = path.join(serviceDir, STATE_FILE);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Update agent state for a specific network
 */
export function updateNetworkAgentState(
  serviceDir: string,
  network: Network,
  networkState: NetworkAgentState
): void {
  const state = loadAgentState(serviceDir);
  state[network] = networkState;
  saveAgentState(serviceDir, state);
}

/**
 * Load agent API keys (with secure permissions check)
 */
export function loadAgentKeys(serviceDir: string): AgentKeys {
  const keysPath = path.join(serviceDir, KEYS_FILE);
  if (!fs.existsSync(keysPath)) {
    return {};
  }
  const content = fs.readFileSync(keysPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Save agent API keys (with secure permissions)
 */
export function saveAgentKeys(serviceDir: string, keys: AgentKeys): void {
  const keysPath = path.join(serviceDir, KEYS_FILE);
  fs.writeFileSync(keysPath, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Update a single network's agent key
 */
export function updateAgentKey(serviceDir: string, network: Network, key: string): void {
  const keys = loadAgentKeys(serviceDir);
  keys[network] = key;
  saveAgentKeys(serviceDir, keys);
}

/**
 * Load agent configuration from agent.json
 */
export function loadAgentConfig(serviceDir: string): AgentConfig {
  const configPath = path.join(serviceDir, AGENT_CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    throw new Error(`agent.json not found at ${configPath}`);
  }
  const content = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Load environment variables from .env.test
 */
export function loadEnvFile(serviceDir: string): Record<string, string> {
  const envPath = path.join(serviceDir, ENV_FILE);
  const env: Record<string, string> = {};

  if (!fs.existsSync(envPath)) {
    return env;
  }

  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const eqIndex = line.indexOf('=');
    if (eqIndex > 0 && !line.trim().startsWith('#')) {
      const key = line.slice(0, eqIndex).trim();
      const value = line.slice(eqIndex + 1).trim();
      env[key] = value;
    }
  }

  return env;
}

/**
 * Get API key prefix (first 10 chars after 'uk_' or 'ak_')
 */
export function getKeyPrefix(fullKey: string): string {
  // Format: uk_xxx... or ak_xxx...
  // Return the prefix portion for identification
  if (fullKey.length > 13) {
    return fullKey.slice(0, 13) + '...';
  }
  return fullKey;
}

/**
 * Clean up old-style agent ID files
 */
export function cleanupOldAgentIdFiles(serviceDir: string): void {
  const oldFiles = ['.agent-id', '.agent-id.prod'];
  for (const file of oldFiles) {
    const filePath = path.join(serviceDir, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`  Removed old ${file} file`);
    }
  }
}

/**
 * Check if an agent was previously registered using old system
 */
export function hasLegacyAgentId(serviceDir: string, production: boolean): string | null {
  const fileName = production ? '.agent-id.prod' : '.agent-id';
  const filePath = path.join(serviceDir, fileName);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8').trim();
  }
  return null;
}

/**
 * Strip JSONC comments from a string (handles strings correctly)
 */
function stripJsoncComments(content: string): string {
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';

  while (i < content.length) {
    const char = content[i];
    const next = content[i + 1];

    // Handle string boundaries
    if ((char === '"' || char === "'") && (i === 0 || content[i - 1] !== '\\')) {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
      }
      result += char;
      i++;
      continue;
    }

    // If inside a string, just copy
    if (inString) {
      result += char;
      i++;
      continue;
    }

    // Handle single-line comments
    if (char === '/' && next === '/') {
      // Skip until end of line
      while (i < content.length && content[i] !== '\n') {
        i++;
      }
      continue;
    }

    // Handle multi-line comments
    if (char === '/' && next === '*') {
      i += 2;
      while (i < content.length - 1 && !(content[i] === '*' && content[i + 1] === '/')) {
        i++;
      }
      i += 2; // Skip */
      continue;
    }

    result += char;
    i++;
  }

  // Also remove trailing commas before } or ]
  result = result.replace(/,(\s*[}\]])/g, '$1');

  return result;
}

/**
 * Load wrangler.jsonc configuration
 */
export function loadWranglerConfig(serviceDir: string): Record<string, unknown> | null {
  const wranglerPath = path.join(serviceDir, 'wrangler.jsonc');
  if (!fs.existsSync(wranglerPath)) {
    // Try wrangler.json without comments
    const jsonPath = path.join(serviceDir, 'wrangler.json');
    if (fs.existsSync(jsonPath)) {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    }
    return null;
  }

  const content = fs.readFileSync(wranglerPath, 'utf-8');
  const stripped = stripJsoncComments(content);
  return JSON.parse(stripped);
}

/**
 * Get endpoint from wrangler environment config
 */
export function getEndpointFromWrangler(serviceDir: string, network: Network): string | null {
  const config = loadWranglerConfig(serviceDir);
  if (!config) return null;

  const envName = network === 'main' ? 'production' : 'test';
  const envConfig = (config.env as Record<string, unknown>)?.[envName] as Record<string, unknown> | undefined;

  if (!envConfig?.routes) return null;

  const routes = envConfig.routes as Array<{ pattern?: string; custom_domain?: boolean }>;
  const customDomainRoute = routes.find(r => r.custom_domain && r.pattern);

  if (customDomainRoute?.pattern) {
    return `https://${customDomainRoute.pattern}`;
  }

  return null;
}
