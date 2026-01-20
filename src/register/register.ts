/**
 * Agent Registration Logic
 */

import { execSync } from 'child_process';
import type { Network } from '../types.js';
import type {
  RegisterOptions,
  RegisterResult,
  AgentConfig,
  ArkeAgent,
  ArkeCollection,
  ArkeApiKey,
  NetworkAgentState,
} from './types.js';
import {
  findRepoRoot,
  loadRegistry,
  saveRegistry,
  loadAgentState,
  updateNetworkAgentState,
  updateAgentKey,
  loadAgentConfig,
  loadEnvFile,
  getKeyPrefix,
  cleanupOldAgentIdFiles,
  getEndpointFromWrangler,
} from './config.js';

const DEFAULT_API_URL = 'https://arke-v1.arke.institute';

/**
 * Make an authenticated API request to Arke
 */
async function apiRequest<T>(
  apiUrl: string,
  userKey: string,
  network: Network,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {
    'Authorization': `ApiKey ${userKey}`,
    'Content-Type': 'application/json',
    'X-Arke-Network': network,
  };

  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`API error (${res.status}): ${error}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Push agent API key to Cloudflare worker secret
 */
async function pushToWranglerSecret(
  serviceDir: string,
  network: Network,
  agentKey: string
): Promise<boolean> {
  const wranglerEnv = network === 'main' ? 'production' : 'test';

  try {
    // Use echo to pipe the key to wrangler secret put
    execSync(`echo "${agentKey}" | wrangler secret put ARKE_API_KEY --env ${wranglerEnv}`, {
      cwd: serviceDir,
      stdio: 'pipe',
    });
    return true;
  } catch (error) {
    console.warn(`  Warning: Could not push secret to wrangler (env: ${wranglerEnv})`);
    console.warn(`  You may need to run: wrangler secret put ARKE_API_KEY --env ${wranglerEnv}`);
    return false;
  }
}

/**
 * Create the Agent Home collection
 */
async function createAgentHome(
  apiUrl: string,
  userKey: string,
  network: Network
): Promise<string> {
  const result = await apiRequest<ArkeCollection>(
    apiUrl,
    userKey,
    network,
    'POST',
    '/collections',
    {
      label: 'Agent Home',
      description: 'Shared home collection for all Arke agents',
    }
  );
  return result.id;
}

/**
 * Create a new agent
 */
async function createAgent(
  apiUrl: string,
  userKey: string,
  network: Network,
  config: AgentConfig,
  agentHome: string
): Promise<{ id: string; cid: string }> {
  const body: Record<string, unknown> = {
    label: config.label,
    description: config.description,
    endpoint: config.endpoint,
    actions_required: config.actions_required,
    collection: agentHome,
  };

  if (config.input_schema) {
    body.input_schema = config.input_schema;
  }

  if (config.uses_agents) {
    body.uses_agents = config.uses_agents;
  }

  return apiRequest<{ id: string; cid: string }>(
    apiUrl,
    userKey,
    network,
    'POST',
    '/agents',
    body
  );
}

/**
 * Add relationship from Agent Home collection to Agent
 * (Agent already has collection reference from creation)
 */
async function linkAgentToHome(
  apiUrl: string,
  userKey: string,
  network: Network,
  agentHomeId: string,
  agentId: string
): Promise<void> {
  // Get current CID using lightweight tip endpoint (no manifest fetch, no permission check)
  const { cid } = await apiRequest<{ cid: string }>(
    apiUrl, userKey, network, 'GET', `/entities/${agentHomeId}/tip`
  );

  // Add relationship: collection "has_agent" -> agent
  await apiRequest(
    apiUrl,
    userKey,
    network,
    'PUT',
    `/collections/${agentHomeId}`,
    {
      expect_tip: cid,
      relationships_add: [
        { predicate: 'has_agent', peer: agentId }
      ],
    }
  );
}

/**
 * Activate an agent
 */
async function activateAgent(
  apiUrl: string,
  userKey: string,
  network: Network,
  agentId: string,
  cid: string
): Promise<void> {
  await apiRequest(
    apiUrl,
    userKey,
    network,
    'PUT',
    `/agents/${agentId}`,
    {
      expect_tip: cid,
      status: 'active',
    }
  );
}

/**
 * Update an existing agent's metadata
 */
async function updateAgent(
  apiUrl: string,
  userKey: string,
  network: Network,
  agentId: string,
  config: AgentConfig
): Promise<void> {
  // Get current CID using lightweight tip endpoint
  const { cid } = await apiRequest<{ cid: string }>(
    apiUrl, userKey, network, 'GET', `/entities/${agentId}/tip`
  );

  const body: Record<string, unknown> = {
    expect_tip: cid,
    properties: {
      label: config.label,
      description: config.description,
      endpoint: config.endpoint,
    },
  };

  // Also update actions_required and input_schema if they exist
  if (config.actions_required) {
    body.actions_required = config.actions_required;
  }

  if (config.input_schema) {
    body.input_schema = config.input_schema;
  }

  if (config.uses_agents) {
    body.uses_agents = config.uses_agents;
  }

  await apiRequest(
    apiUrl,
    userKey,
    network,
    'PUT',
    `/agents/${agentId}`,
    body
  );
}

/**
 * Create an API key for an agent
 */
async function createAgentKey(
  apiUrl: string,
  userKey: string,
  network: Network,
  agentId: string,
  label: string
): Promise<ArkeApiKey> {
  return apiRequest<ArkeApiKey>(
    apiUrl,
    userKey,
    network,
    'POST',
    `/agents/${agentId}/keys`,
    { label }
  );
}

/**
 * Main registration function
 */
export async function registerAgent(options: RegisterOptions = {}): Promise<RegisterResult> {
  const cwd = options.cwd || process.cwd();
  const network: Network = options.production ? 'main' : 'test';
  const networkLabel = options.production ? 'production' : 'test';

  console.log(`\n📦 Agent Registration (${networkLabel} network)\n`);

  // Find repo root for shared registry
  const repoRoot = findRepoRoot(cwd);

  // Load environment file
  const envVars = loadEnvFile(cwd);

  // Get user API key (check multiple possible names for backwards compatibility)
  const userKey = options.userKey
    || envVars.ARKE_USER_KEY
    || envVars.ARKE_API_KEY  // Legacy support
    || process.env.ARKE_USER_KEY
    || process.env.ARKE_API_KEY;

  if (!userKey) {
    throw new Error(
      'User API key required. Set ARKE_USER_KEY in .env.test or environment.'
    );
  }

  const apiUrl = options.apiUrl
    || envVars.ARKE_API_URL
    || process.env.ARKE_API_URL
    || DEFAULT_API_URL;

  // Load agent configuration
  const agentConfig = loadAgentConfig(cwd);

  // Check if wrangler.jsonc has an environment-specific endpoint
  const wranglerEndpoint = getEndpointFromWrangler(cwd, network);
  if (wranglerEndpoint) {
    agentConfig.endpoint = wranglerEndpoint;
  }

  console.log(`Agent: ${agentConfig.label}`);
  console.log(`Endpoint: ${agentConfig.endpoint}`);
  console.log(`Actions: ${JSON.stringify(agentConfig.actions_required)}`);
  console.log('');

  // Load existing state
  const registry = loadRegistry(repoRoot);
  const agentState = loadAgentState(cwd);
  const existingState = agentState[network];

  // Determine agent home collection
  let agentHome = options.agentHome
    || envVars.AGENT_HOME
    || process.env.AGENT_HOME
    || registry[network]?.agent_home;

  let isNew = !existingState?.agent_id;
  let agentId: string;
  let agentKeyPrefix: string;
  let secretPushed = false;

  if (existingState?.agent_id) {
    // Update existing agent
    agentId = existingState.agent_id;
    agentKeyPrefix = existingState.agent_key_prefix;
    agentHome = existingState.agent_home;

    console.log(`Updating existing agent: ${agentId}`);

    try {
      await updateAgent(apiUrl, userKey, network, agentId, agentConfig);
      console.log(`✅ Agent updated: ${agentId}`);

      // Update state with new timestamp
      updateNetworkAgentState(cwd, network, {
        ...existingState,
        updated_at: new Date().toISOString(),
        endpoint: agentConfig.endpoint,
      });
    } catch (error) {
      throw new Error(`Failed to update agent: ${error}`);
    }
  } else {
    // Create new agent
    console.log('Creating new agent...');

    try {
      // Clean up any old-style agent ID files
      cleanupOldAgentIdFiles(cwd);

      // Get or create agent home collection
      if (!agentHome) {
        console.log('Creating agent home collection...');
        agentHome = await createAgentHome(apiUrl, userKey, network);
        console.log(`✅ Created agent home: ${agentHome}`);
      } else {
        console.log(`Using agent home: ${agentHome}`);
      }

      // Save to registry if this is a new agent home
      if (!registry[network]?.agent_home) {
        registry[network] = {
          agent_home: agentHome,
          deploying_user_prefix: getKeyPrefix(userKey),
          created_at: new Date().toISOString(),
        };
        saveRegistry(repoRoot, registry);
        console.log(`✅ Saved agent home to registry`);
      }

      // Create the agent
      const result = await createAgent(apiUrl, userKey, network, agentConfig, agentHome);
      agentId = result.id;
      console.log(`✅ Agent created: ${agentId}`);

      // Activate agent
      await activateAgent(apiUrl, userKey, network, agentId, result.cid);
      console.log('✅ Agent activated');

      // Add relationship from Agent Home to Agent
      await linkAgentToHome(apiUrl, userKey, network, agentHome, agentId);
      console.log('✅ Linked agent to Agent Home');

      // Create API key
      console.log('\nCreating API key...');
      const keyResult = await createAgentKey(apiUrl, userKey, network, agentId, networkLabel);
      agentKeyPrefix = getKeyPrefix(keyResult.key);

      // Save state
      const newState: NetworkAgentState = {
        agent_id: agentId,
        agent_key_prefix: agentKeyPrefix,
        agent_home: agentHome,
        registered_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        endpoint: agentConfig.endpoint,
      };
      updateNetworkAgentState(cwd, network, newState);
      console.log(`✅ Saved agent state`);

      // Save full key
      updateAgentKey(cwd, network, keyResult.key);
      console.log(`✅ Saved agent key`);

      // Auto-push to wrangler secrets
      if (!options.skipSecretPush) {
        console.log('\nPushing to Cloudflare secrets...');
        secretPushed = await pushToWranglerSecret(cwd, network, keyResult.key);
        if (secretPushed) {
          console.log(`✅ Secret pushed to wrangler (env: ${network === 'main' ? 'production' : 'test'})`);
        }
      }

      console.log('\n==========================================');
      console.log('🔑 Agent API Key:');
      console.log(`   ${keyResult.key}`);
      console.log('');
      if (!secretPushed) {
        console.log('Set it manually with:');
        console.log(`   wrangler secret put ARKE_API_KEY --env ${network === 'main' ? 'production' : 'test'}`);
      }
      console.log('==========================================\n');

    } catch (error) {
      throw new Error(`Failed to create agent: ${error}`);
    }
  }

  return {
    agentId: agentId!,
    agentKeyPrefix: agentKeyPrefix!,
    agentHome: agentHome!,
    network,
    isNew,
    secretPushed,
  };
}

/**
 * CLI entry point
 */
export function runCli(): void {
  const isProduction = process.argv.includes('--production');
  const skipSecretPush = process.argv.includes('--skip-secret');

  registerAgent({
    production: isProduction,
    skipSecretPush,
  }).catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
