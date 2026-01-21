/**
 * @arke-institute/agent-core/test
 *
 * Testing utilities for Arke agents. Provides helpers for E2E testing against
 * the real Arke API on the test network.
 *
 * @example
 * ```typescript
 * import { getTestClient, runTestCycle } from '@arke-institute/agent-core/test';
 *
 * const result = await runTestCycle({
 *   collectionLabel: 'My Test',
 *   entities: [{ label: 'test.txt' }],
 * });
 * expect(result.finalStatus.status).toBe('done');
 * ```
 *
 * All tests run on the test network (X-Arke-Network: test) which:
 * - Creates II-prefixed entity IDs (vs 01-prefixed for production)
 * - Uses isolated storage paths
 * - Keeps test data completely separate from production
 * - Entities auto-expire after 30 days
 */

import { ArkeClient } from '@arke-institute/sdk';
import * as fs from 'fs';
import * as path from 'path';
import type { Network } from '../types.js';
import {
  loadAgentState,
  loadAgentConfig,
  loadEnvFile,
  loadAgentKeys,
  findRepoRoot,
  getEndpointFromWrangler,
} from '../register/config.js';
import type { AgentState, NetworkAgentState } from '../register/types.js';

// =============================================================================
// Types
// =============================================================================

export type TestNetwork = 'test' | 'main';

export interface TestConfig {
  /** Base URL for Arke API */
  baseUrl: string;
  /** API key for testing (user key or agent key) */
  apiKey: string;
  /** Network to test against */
  network: TestNetwork;
  /** Agent endpoint URL */
  agentEndpoint: string;
  /** Agent ID */
  agentId: string;
  /** Service directory (for loading config files) */
  serviceDir: string;
}

export interface InvokeOptions {
  /** Target collection ID */
  target: string;
  /** Input data for the agent */
  input?: Record<string, unknown>;
  /** Expiration time in seconds (default: 3600) */
  expiresIn?: number;
  /** Skip user confirmation (default: true for tests) */
  confirm?: boolean;
  /** Override agent ID */
  agentId?: string;
}

export interface InvokeResult {
  status: 'started' | 'error';
  job_id?: string;
  job_collection?: string;
  error?: string;
}

export interface JobStatus {
  job_id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  started_at?: string;
  completed_at?: string;
}

export interface LambdaTestConfig {
  /** Lambda function URL */
  url: string;
  /** Lambda secret for authentication */
  secret: string;
}

export interface LambdaSecretsFile {
  [serviceName: string]: {
    lambda_function: string;
    worker_dir: string;
    secret: string;
    additional_env_vars?: string[];
  };
}

// =============================================================================
// Configuration Loading
// =============================================================================

/**
 * Apply environment variables from .env.test to process.env
 */
function applyEnvFile(serviceDir: string): void {
  const env = loadEnvFile(serviceDir);
  for (const [key, value] of Object.entries(env)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

/**
 * Load Lambda secrets from central lambda-secrets.json
 */
function loadLambdaSecrets(repoRoot: string): LambdaSecretsFile | null {
  const secretsPath = path.join(repoRoot, 'lambda-secrets.json');
  if (!fs.existsSync(secretsPath)) return null;
  return JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
}

// =============================================================================
// Test Configuration
// =============================================================================

let cachedConfig: TestConfig | null = null;
let cachedClient: ArkeClient | null = null;

export interface LoadTestConfigOptions {
  /** Service directory (default: process.cwd()) */
  serviceDir?: string;
  /** Network to test against (default: 'test') */
  network?: TestNetwork;
  /** Force reload configuration */
  reload?: boolean;
}

/**
 * Load test configuration from environment and config files
 *
 * Reads from (in order of precedence):
 * 1. Environment variables (ARKE_USER_KEY, AGENT_ID, etc.)
 * 2. .agent-state.json (created by registration)
 * 3. agent.json (static config)
 * 4. .env.test (environment file)
 */
export function loadTestConfig(options: LoadTestConfigOptions = {}): TestConfig {
  if (cachedConfig && !options.reload) {
    return cachedConfig;
  }

  const serviceDir = options.serviceDir || process.cwd();
  const network = options.network || 'test';

  // Load .env.test and apply to process.env
  applyEnvFile(serviceDir);

  // Get API key (prefer ARKE_USER_KEY, fall back to ARKE_API_KEY)
  const apiKey = process.env.ARKE_USER_KEY || process.env.ARKE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'API key required for testing.\n' +
        'Set ARKE_USER_KEY in .env.test or as environment variable:\n' +
        '  ARKE_USER_KEY=uk_your_api_key_here'
    );
  }

  // Load agent state (from new registration system)
  const agentState = loadAgentState(serviceDir);
  const networkState = agentState[network];

  // Load agent.json for fallback values
  let agentConfig: { endpoint?: string } = {};
  try {
    const loaded = loadAgentConfig(serviceDir);
    agentConfig = { endpoint: loaded.endpoint };
  } catch {
    // agent.json is optional for tests
  }

  // Try to get endpoint from wrangler.jsonc
  const wranglerEndpoint = getEndpointFromWrangler(serviceDir, network as Network);

  // Determine agent ID and endpoint
  const agentId =
    process.env.AGENT_ID ||
    networkState?.agent_id ||
    '';

  const agentEndpoint =
    process.env.AGENT_ENDPOINT ||
    networkState?.endpoint ||
    wranglerEndpoint ||
    agentConfig.endpoint ||
    '';

  cachedConfig = {
    baseUrl: process.env.ARKE_API_BASE || 'https://arke-v1.arke.institute',
    apiKey,
    network,
    agentEndpoint,
    agentId,
    serviceDir,
  };

  return cachedConfig;
}

/**
 * Get test configuration (cached)
 */
export function getTestConfig(): TestConfig {
  return loadTestConfig();
}

/**
 * Reset cached configuration and client
 */
export function resetTestConfig(): void {
  cachedConfig = null;
  cachedClient = null;
}

// =============================================================================
// Test Client
// =============================================================================

/**
 * Get configured ArkeClient for tests
 */
export function getTestClient(options: LoadTestConfigOptions = {}): ArkeClient {
  if (cachedClient && !options.reload) {
    return cachedClient;
  }

  const config = loadTestConfig(options);

  cachedClient = new ArkeClient({
    baseUrl: config.baseUrl,
    authToken: config.apiKey,
    network: config.network,
  });

  return cachedClient;
}

/**
 * Get auth headers for direct fetch calls
 */
export function getAuthHeaders(config?: TestConfig): Record<string, string> {
  const c = config || getTestConfig();
  return {
    Authorization: `ApiKey ${c.apiKey}`,
    'Content-Type': 'application/json',
    'X-Arke-Network': c.network,
  };
}

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create a test collection
 */
export async function createTestCollection(
  label?: string,
  config?: TestConfig
): Promise<{ id: string; cid: string }> {
  const c = config || getTestConfig();
  const headers = getAuthHeaders(c);

  const response = await fetch(`${c.baseUrl}/collections`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      label: label || `Test Collection ${Date.now()}`,
      description: 'Temporary collection for agent E2E testing',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create test collection: ${error}`);
  }

  return response.json();
}

/**
 * Create a test file entity in a collection
 */
export async function createTestEntity(
  collectionId: string,
  options?: {
    label?: string;
    contentType?: string;
    size?: number;
    properties?: Record<string, unknown>;
  },
  config?: TestConfig
): Promise<{ id: string; cid: string }> {
  const c = config || getTestConfig();
  const headers = getAuthHeaders(c);
  const opts = options || {};

  const key = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const response = await fetch(`${c.baseUrl}/files`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      key,
      filename: opts.label || `test-${Date.now()}.txt`,
      content_type: opts.contentType || 'text/plain',
      size: opts.size || 100,
      collection: collectionId,
      ...opts.properties,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create test entity: ${error}`);
  }

  return response.json();
}

/**
 * Upload content to a file entity
 */
export async function uploadTestContent(
  entityId: string,
  content: Buffer | string,
  contentType?: string,
  config?: TestConfig
): Promise<void> {
  const c = config || getTestConfig();

  const response = await fetch(`${c.baseUrl}/files/${entityId}/content`, {
    method: 'POST',
    headers: {
      Authorization: `ApiKey ${c.apiKey}`,
      'Content-Type': contentType || 'application/octet-stream',
      'X-Arke-Network': c.network,
    },
    body: content,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to upload content: ${error}`);
  }
}

// =============================================================================
// Agent Invocation
// =============================================================================

/**
 * Invoke an agent via the Arke API
 */
export async function invokeAgent(
  options: InvokeOptions,
  config?: TestConfig
): Promise<InvokeResult> {
  const c = config || getTestConfig();
  const headers = getAuthHeaders(c);

  const agentId = options.agentId || c.agentId;
  if (!agentId) {
    throw new Error(
      'Agent ID not configured.\n' +
        'Either:\n' +
        '  - Run "npm run register" to register the agent\n' +
        '  - Set AGENT_ID environment variable\n' +
        '  - Pass agentId in options'
    );
  }

  const response = await fetch(`${c.baseUrl}/agents/${agentId}/invoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      target: options.target,
      input: options.input || {},
      expires_in: options.expiresIn || 3600,
      confirm: options.confirm ?? true,
    }),
  });

  const data = (await response.json()) as InvokeResult & { error?: string };

  if (!response.ok) {
    return {
      status: 'error',
      error: data.error || `HTTP ${response.status}`,
    };
  }

  return data as InvokeResult;
}

// =============================================================================
// Status Polling
// =============================================================================

export interface PollOptions {
  /** Polling interval in ms (default: 1000) */
  interval?: number;
  /** Timeout in ms (default: 60000) */
  timeout?: number;
  /** Callback on each poll */
  onPoll?: (status: JobStatus) => void;
}

/**
 * Poll agent job status until completion or timeout
 */
export async function pollJobStatus(
  jobId: string,
  options: PollOptions = {},
  config?: TestConfig
): Promise<JobStatus> {
  const c = config || getTestConfig();
  const interval = options.interval || 1000;
  const timeout = options.timeout || 60000;
  const startTime = Date.now();

  if (!c.agentEndpoint) {
    throw new Error(
      'Agent endpoint not configured.\n' +
        'Either:\n' +
        '  - Run "npm run register" to register the agent\n' +
        '  - Set AGENT_ENDPOINT environment variable'
    );
  }

  while (Date.now() - startTime < timeout) {
    const response = await fetch(`${c.agentEndpoint}/status/${jobId}`);

    if (!response.ok) {
      throw new Error(`Failed to get job status: ${await response.text()}`);
    }

    const status: JobStatus = await response.json();
    options.onPoll?.(status);

    if (status.status === 'done' || status.status === 'error') {
      return status;
    }

    await sleep(interval);
  }

  throw new Error(`Polling timeout after ${timeout}ms for job ${jobId}`);
}

// =============================================================================
// Job Collection
// =============================================================================

export interface JobCollectionInfo {
  id: string;
  cid: string;
  properties: Record<string, unknown>;
  files: Array<{ id: string; cid: string; properties: Record<string, unknown> }>;
}

/**
 * Get job collection with all contained files
 */
export async function getJobCollection(
  jobCollectionId: string,
  config?: TestConfig
): Promise<JobCollectionInfo> {
  const c = config || getTestConfig();
  const headers = getAuthHeaders(c);

  // Get collection
  const collectionRes = await fetch(`${c.baseUrl}/collections/${jobCollectionId}`, {
    headers,
  });

  if (!collectionRes.ok) {
    throw new Error(`Failed to get job collection: ${await collectionRes.text()}`);
  }

  const collection = (await collectionRes.json()) as {
    id: string;
    cid: string;
    properties: Record<string, unknown>;
    relationships?: Array<{ predicate: string; peer: string }>;
  };

  // Get contained files
  const containsRels =
    collection.relationships?.filter((r) => r.predicate === 'contains') || [];

  const files: JobCollectionInfo['files'] = [];
  for (const rel of containsRels) {
    const entityRes = await fetch(`${c.baseUrl}/entities/${rel.peer}`, { headers });
    if (entityRes.ok) {
      const entity = (await entityRes.json()) as {
        id: string;
        cid: string;
        properties: Record<string, unknown>;
      };
      files.push({
        id: entity.id,
        cid: entity.cid,
        properties: entity.properties,
      });
    }
  }

  return {
    id: collection.id,
    cid: collection.cid,
    properties: collection.properties,
    files,
  };
}

// =============================================================================
// Lambda Testing (for Lambda-backed agents)
// =============================================================================

export interface LambdaInvokeOptions {
  /** Request body */
  body: Record<string, unknown>;
  /** Override Lambda URL */
  url?: string;
  /** Override Lambda secret */
  secret?: string;
}

export interface LambdaInvokeResult {
  success: boolean;
  statusCode: number;
  body: Record<string, unknown>;
}

/**
 * Get Lambda test configuration from central secrets file
 */
export function getLambdaConfig(serviceName: string): LambdaTestConfig | null {
  const config = getTestConfig();

  let repoRoot: string;
  try {
    repoRoot = findRepoRoot(config.serviceDir);
  } catch {
    return null;
  }

  const secrets = loadLambdaSecrets(repoRoot);
  if (!secrets?.[serviceName]) return null;

  const serviceSecrets = secrets[serviceName];

  // Try to get Lambda URL from wrangler.jsonc vars
  const serviceDir = path.join(repoRoot, serviceSecrets.worker_dir);
  let lambdaUrl = '';

  try {
    const wranglerPath = path.join(serviceDir, 'wrangler.jsonc');
    if (fs.existsSync(wranglerPath)) {
      const content = fs.readFileSync(wranglerPath, 'utf-8');
      // Simple extraction - look for LAMBDA_URL in vars
      const match = content.match(/"LAMBDA_URL"\s*:\s*"([^"]+)"/);
      if (match) {
        lambdaUrl = match[1];
      }
    }
  } catch {
    // Ignore errors reading wrangler config
  }

  return {
    url: lambdaUrl,
    secret: serviceSecrets.secret,
  };
}

/**
 * Invoke Lambda function directly for testing
 *
 * Useful for testing Lambda functions in isolation without going through
 * the Cloudflare Worker.
 */
export async function invokeLambda(
  serviceName: string,
  options: LambdaInvokeOptions
): Promise<LambdaInvokeResult> {
  const lambdaConfig = getLambdaConfig(serviceName);

  const url = options.url || lambdaConfig?.url;
  const secret = options.secret || lambdaConfig?.secret;

  if (!url) {
    throw new Error(
      `Lambda URL not configured for service "${serviceName}".\n` +
        'Either:\n' +
        '  - Ensure LAMBDA_URL is set in wrangler.jsonc\n' +
        '  - Pass url in options'
    );
  }

  if (!secret) {
    throw new Error(
      `Lambda secret not configured for service "${serviceName}".\n` +
        'Check lambda-secrets.json at repo root.'
    );
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Lambda-Secret': secret,
    },
    body: JSON.stringify(options.body),
  });

  const body = (await response.json()) as Record<string, unknown>;

  return {
    success: response.ok && body.success !== false,
    statusCode: response.status,
    body,
  };
}

/**
 * Test Lambda authentication by sending request with wrong secret
 */
export async function testLambdaAuth(
  serviceName: string,
  lambdaUrl?: string
): Promise<{ authenticated: boolean; error?: string }> {
  const lambdaConfig = getLambdaConfig(serviceName);
  const url = lambdaUrl || lambdaConfig?.url;

  if (!url) {
    return { authenticated: false, error: 'Lambda URL not configured' };
  }

  // Test with wrong secret
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Lambda-Secret': 'wrong-secret-for-testing',
    },
    body: JSON.stringify({}),
  });

  const body = (await response.json()) as { error?: string };

  // Should get Unauthorized with wrong secret
  if (body.error === 'Unauthorized' || response.status === 401) {
    return { authenticated: true };
  }

  return {
    authenticated: false,
    error: 'Lambda did not reject invalid secret',
  };
}

// =============================================================================
// Full Test Cycle
// =============================================================================

export interface TestCycleOptions {
  /** Label for test collection */
  collectionLabel?: string;
  /** Test entities to create */
  entities?: Array<{
    label?: string;
    contentType?: string;
    content?: Buffer | string;
    properties?: Record<string, unknown>;
  }>;
  /** Input data for agent (entity_id is auto-filled from first entity) */
  input?: Record<string, unknown>;
  /** Timeout for polling (default: 60000) */
  timeout?: number;
  /** Callback on status poll */
  onPoll?: (status: JobStatus) => void;
}

export interface TestCycleResult {
  collection: { id: string; cid: string };
  entities: Array<{ id: string; cid: string }>;
  invokeResult: InvokeResult;
  finalStatus: JobStatus;
  jobCollection?: JobCollectionInfo;
  duration: number;
}

/**
 * Run a full agent test cycle
 *
 * 1. Creates a test collection
 * 2. Creates test entities (with optional content upload)
 * 3. Invokes the agent
 * 4. Polls until completion
 * 5. Returns all results
 */
export async function runTestCycle(
  options: TestCycleOptions = {},
  config?: TestConfig
): Promise<TestCycleResult> {
  const c = config || getTestConfig();
  const startTime = Date.now();

  // 1. Create test collection
  const collection = await createTestCollection(options.collectionLabel, c);

  // 2. Create test entities
  const entityConfigs = options.entities || [{ label: 'Test Entity' }];
  const entities: Array<{ id: string; cid: string }> = [];

  for (const entityConfig of entityConfigs) {
    const entity = await createTestEntity(
      collection.id,
      {
        label: entityConfig.label,
        contentType: entityConfig.contentType,
        properties: entityConfig.properties,
      },
      c
    );

    // Upload content if provided
    if (entityConfig.content) {
      await uploadTestContent(
        entity.id,
        entityConfig.content,
        entityConfig.contentType,
        c
      );
    }

    entities.push(entity);
  }

  // 3. Invoke agent
  const invokeResult = await invokeAgent(
    {
      target: collection.id,
      input: {
        entity_id: entities[0].id,
        ...options.input,
      },
    },
    c
  );

  if (invokeResult.status !== 'started' || !invokeResult.job_id) {
    throw new Error(`Agent invocation failed: ${invokeResult.error}`);
  }

  // 4. Poll for completion
  const finalStatus = await pollJobStatus(
    invokeResult.job_id,
    {
      timeout: options.timeout || 60000,
      onPoll: options.onPoll,
    },
    c
  );

  // 5. Get job collection info
  let jobCollection: JobCollectionInfo | undefined;
  if (invokeResult.job_collection) {
    jobCollection = await getJobCollection(invokeResult.job_collection, c);
  }

  return {
    collection,
    entities,
    invokeResult,
    finalStatus,
    jobCollection,
    duration: Date.now() - startTime,
  };
}

// =============================================================================
// Utilities
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Assert that a condition is true, with a custom error message
 */
export function assertTest(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Test assertion failed: ${message}`);
  }
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const timeout = options.timeout || 10000;
  const interval = options.interval || 100;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) return;
    await sleep(interval);
  }

  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}

// Re-export types that tests might need
export type { AgentState, NetworkAgentState } from '../register/types.js';
export type { Network } from '../types.js';
