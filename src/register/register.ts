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
  VerifyTokenResponse,
  VerifyResultResponse,
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
 * Push verification token and agent ID to Cloudflare worker secrets
 */
async function pushVerifySecretsToWrangler(
  serviceDir: string,
  network: Network,
  token: string,
  agentId: string
): Promise<boolean> {
  const wranglerEnv = network === 'main' ? 'production' : 'test';

  try {
    // Push verification token
    execSync(`echo "${token}" | wrangler secret put ARKE_VERIFY_TOKEN --env ${wranglerEnv}`, {
      cwd: serviceDir,
      stdio: 'pipe',
    });
    // Push agent ID (the actual entity ID, not the human-readable name)
    execSync(`echo "${agentId}" | wrangler secret put ARKE_VERIFY_AGENT_ID --env ${wranglerEnv}`, {
      cwd: serviceDir,
      stdio: 'pipe',
    });
    return true;
  } catch (error) {
    console.warn(`  Warning: Could not push verification secrets to wrangler`);
    return false;
  }
}

/**
 * Delete verification secrets from Cloudflare (cleanup after successful verification)
 */
async function deleteVerifySecretsFromWrangler(
  serviceDir: string,
  network: Network
): Promise<boolean> {
  const wranglerEnv = network === 'main' ? 'production' : 'test';

  try {
    execSync(`wrangler secret delete ARKE_VERIFY_TOKEN --env ${wranglerEnv} --force`, {
      cwd: serviceDir,
      stdio: 'pipe',
    });
    execSync(`wrangler secret delete ARKE_VERIFY_AGENT_ID --env ${wranglerEnv} --force`, {
      cwd: serviceDir,
      stdio: 'pipe',
    });
    return true;
  } catch {
    // Not critical if this fails
    return false;
  }
}

/**
 * Wait for worker deployment to be ready (health check)
 */
async function waitForDeployment(endpoint: string, maxWaitMs: number = 30000): Promise<boolean> {
  const startTime = Date.now();
  const checkInterval = 2000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(`${endpoint}/health`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      if (res.ok) return true;
    } catch {
      // Ignore errors, keep trying
    }
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
  return false;
}

/**
 * Request verification token from API
 */
async function requestVerificationToken(
  apiUrl: string,
  userKey: string,
  network: Network,
  agentId: string
): Promise<VerifyTokenResponse> {
  return apiRequest<VerifyTokenResponse>(
    apiUrl,
    userKey,
    network,
    'POST',
    `/agents/${agentId}/verify`,
    {}  // Empty body = generate token
  );
}

/**
 * Confirm verification (triggers API callback to agent endpoint)
 */
async function confirmVerification(
  apiUrl: string,
  userKey: string,
  network: Network,
  agentId: string
): Promise<VerifyResultResponse> {
  return apiRequest<VerifyResultResponse>(
    apiUrl,
    userKey,
    network,
    'POST',
    `/agents/${agentId}/verify`,
    { confirm: true }
  );
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

  if (config.output_description) {
    body.output_description = config.output_description;
  }

  if (config.output_tree_example) {
    body.output_tree_example = config.output_tree_example;
  }

  if (config.output_relationships) {
    body.output_relationships = config.output_relationships;
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

  const properties: Record<string, unknown> = {
    label: config.label,
    description: config.description,
    endpoint: config.endpoint,
  };

  if (config.output_description) {
    properties.output_description = config.output_description;
  }

  if (config.output_tree_example) {
    properties.output_tree_example = config.output_tree_example;
  }

  if (config.output_relationships) {
    properties.output_relationships = config.output_relationships;
  }

  const body: Record<string, unknown> = {
    expect_tip: cid,
    properties,
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

    // Check if endpoint changed (requires re-verification)
    const endpointChanged = existingState.endpoint !== agentConfig.endpoint;

    console.log(`Updating existing agent: ${agentId}`);
    if (endpointChanged) {
      console.log(`⚠️  Endpoint changed: ${existingState.endpoint} → ${agentConfig.endpoint}`);
      console.log('   Re-verification will be required.');
    }

    try {
      await updateAgent(apiUrl, userKey, network, agentId, agentConfig);
      console.log(`✅ Agent updated: ${agentId}`);

      // If endpoint changed, need to re-verify
      if (endpointChanged) {
        console.log('\n🔐 Re-verifying new endpoint...');

        // Request new verification token
        const verifyResponse = await requestVerificationToken(apiUrl, userKey, network, agentId);
        console.log(`✅ Got verification token`);

        // Push verification secrets to worker
        const tokenPushed = await pushVerifySecretsToWrangler(cwd, network, verifyResponse.verification_token, agentId);
        if (!tokenPushed) {
          throw new Error('Could not push verification secrets to worker');
        }
        console.log('✅ Verification secrets pushed');

        // Wait for deployment
        console.log('Waiting for worker...');
        const isReady = await waitForDeployment(agentConfig.endpoint);
        if (!isReady) {
          console.warn('⚠️  Worker health check timed out, attempting verification anyway...');
        }

        // Confirm verification
        const verifyResult = await confirmVerification(apiUrl, userKey, network, agentId);
        if (!verifyResult.verified) {
          throw new Error(`Endpoint verification failed: ${verifyResult.error}`);
        }
        console.log(`✅ New endpoint verified`);

        // Re-activate (API will have set status back to development on endpoint change)
        const { cid } = await apiRequest<{ cid: string }>(
          apiUrl, userKey, network, 'GET', `/entities/${agentId}/tip`
        );
        await activateAgent(apiUrl, userKey, network, agentId, cid);
        console.log('✅ Agent re-activated');

        // Cleanup verification secrets
        await deleteVerifySecretsFromWrangler(cwd, network);

        // Update state with new verification timestamp
        updateNetworkAgentState(cwd, network, {
          ...existingState,
          updated_at: new Date().toISOString(),
          endpoint: agentConfig.endpoint,
          endpoint_verified_at: verifyResult.verified_at,
        });
      } else {
        // No endpoint change, just update timestamp
        updateNetworkAgentState(cwd, network, {
          ...existingState,
          updated_at: new Date().toISOString(),
          endpoint: agentConfig.endpoint,
        });
      }
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

      // Step 1: Create the agent (status: development)
      const result = await createAgent(apiUrl, userKey, network, agentConfig, agentHome);
      agentId = result.id;
      console.log(`✅ Agent created: ${agentId} (status: development)`);

      // Add relationship from Agent Home to Agent
      await linkAgentToHome(apiUrl, userKey, network, agentHome, agentId);
      console.log('✅ Linked agent to Agent Home');

      // Step 2: Request verification token
      console.log('\n🔐 Endpoint Verification');
      console.log('Requesting verification token...');
      const verifyResponse = await requestVerificationToken(apiUrl, userKey, network, agentId);
      console.log(`✅ Got verification token (expires: ${verifyResponse.expires_at})`);

      // Step 3: Push verification secrets to worker
      console.log('Pushing verification secrets to worker...');
      const tokenPushed = await pushVerifySecretsToWrangler(cwd, network, verifyResponse.verification_token, agentId);
      if (!tokenPushed) {
        throw new Error(
          'Could not push verification secrets. Run manually:\n' +
          `  echo "${verifyResponse.verification_token}" | wrangler secret put ARKE_VERIFY_TOKEN --env ${network === 'main' ? 'production' : 'test'}\n` +
          `  echo "${agentId}" | wrangler secret put ARKE_VERIFY_AGENT_ID --env ${network === 'main' ? 'production' : 'test'}\n` +
          'Then run registration again.'
        );
      }
      console.log('✅ Verification secrets pushed to worker');

      // Step 4: Wait for deployment to propagate
      console.log('Waiting for worker to be ready...');
      const isReady = await waitForDeployment(agentConfig.endpoint);
      if (!isReady) {
        console.warn('⚠️  Worker health check timed out, attempting verification anyway...');
      } else {
        console.log('✅ Worker is responding');
      }

      // Step 5: Trigger verification callback
      console.log('Verifying endpoint ownership...');
      const verifyResult = await confirmVerification(apiUrl, userKey, network, agentId);

      if (!verifyResult.verified) {
        throw new Error(
          `Endpoint verification failed: ${verifyResult.error}\n` +
          `Make sure your worker is deployed at: ${agentConfig.endpoint}\n` +
          'And that it includes the /.well-known/arke-verification endpoint.'
        );
      }
      console.log(`✅ Endpoint verified at ${verifyResult.verified_at}`);

      // Step 6: Activate agent (now allowed since endpoint is verified)
      const { cid: freshCid } = await apiRequest<{ cid: string }>(
        apiUrl, userKey, network, 'GET', `/entities/${agentId}/tip`
      );
      await activateAgent(apiUrl, userKey, network, agentId, freshCid);
      console.log('✅ Agent activated');

      // Step 7: Create API key
      console.log('\n🔑 Creating API key...');
      const keyResult = await createAgentKey(apiUrl, userKey, network, agentId, networkLabel);
      agentKeyPrefix = getKeyPrefix(keyResult.key);

      // Save state (including verification timestamp)
      const newState: NetworkAgentState = {
        agent_id: agentId,
        agent_key_prefix: agentKeyPrefix,
        agent_home: agentHome,
        registered_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        endpoint: agentConfig.endpoint,
        endpoint_verified_at: verifyResult.verified_at,
      };
      updateNetworkAgentState(cwd, network, newState);
      console.log(`✅ Saved agent state`);

      // Save full key
      updateAgentKey(cwd, network, keyResult.key);
      console.log(`✅ Saved agent key`);

      // Step 8: Push agent API key to wrangler secrets
      if (!options.skipSecretPush) {
        console.log('\nPushing API key to Cloudflare secrets...');
        secretPushed = await pushToWranglerSecret(cwd, network, keyResult.key);
        if (secretPushed) {
          console.log(`✅ API key pushed to wrangler (env: ${network === 'main' ? 'production' : 'test'})`);
        }
      }

      // Step 9: Cleanup verification secrets (optional, non-critical)
      console.log('Cleaning up verification secrets...');
      await deleteVerifySecretsFromWrangler(cwd, network);
      console.log('✅ Verification secrets removed');

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
