/**
 * Agent router factory
 *
 * Creates a Hono router with standard endpoints for Arke agents:
 * - GET /health - Health check
 * - POST /process - Accept new jobs
 * - GET /status/:job_id - Query job status
 *
 * The router handles signature verification and delegates to the
 * agent's Durable Object for job processing.
 */

import { Hono } from 'hono';
import type { BaseJobRequest, JobResponse, BaseAgentEnv } from './types';
import { verifyArkeSignature } from './verify';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for creating an agent router.
 */
export interface AgentRouterConfig<TEnv extends BaseAgentEnv> {
  /**
   * Name of the DO namespace binding (e.g., 'PIPELINE_JOBS', 'ORCHESTRATOR_JOBS')
   */
  doBindingName: keyof TEnv;

  /**
   * Optional custom health response data
   */
  healthData?: (env: TEnv) => Record<string, unknown>;

  /**
   * Optional pre-processing before dispatching to DO.
   * Return modified request or throw to reject.
   */
  preProcess?: (
    request: BaseJobRequest,
    env: TEnv
  ) => Promise<BaseJobRequest> | BaseJobRequest;
}

// =============================================================================
// Router Factory
// =============================================================================

/**
 * Create a Hono router for an Arke agent.
 *
 * @param config - Router configuration
 * @returns Hono app configured with standard endpoints
 */
export function createAgentRouter<TEnv extends BaseAgentEnv>(
  config: AgentRouterConfig<TEnv>
): Hono<{ Bindings: TEnv }> {
  const app = new Hono<{ Bindings: TEnv }>();

  // ===========================================================================
  // GET /health
  // ===========================================================================

  app.get('/health', (c) => {
    const baseData = {
      status: 'healthy',
      agent: c.env.AGENT_ID,
      version: c.env.AGENT_VERSION,
      uses_durable_objects: true,
    };

    const customData = config.healthData?.(c.env) ?? {};

    return c.json({ ...baseData, ...customData });
  });

  // ===========================================================================
  // POST /process
  // ===========================================================================

  app.post('/process', async (c) => {
    const env = c.env;

    // 1. Read raw body for signature verification
    const body = await c.req.text();
    const signatureHeader = c.req.header('X-Arke-Signature');
    const requestId = c.req.header('X-Arke-Request-Id');

    console.log(`[${env.AGENT_ID}] Received request ${requestId}`);

    // 2. Verify signature
    if (!signatureHeader) {
      return c.json<JobResponse>(
        { accepted: false, error: 'Missing signature header' },
        401
      );
    }

    let jobRequest: BaseJobRequest;
    try {
      jobRequest = JSON.parse(body) as BaseJobRequest;
    } catch {
      return c.json<JobResponse>(
        { accepted: false, error: 'Invalid JSON body' },
        400
      );
    }

    const verifyResult = await verifyArkeSignature(
      body,
      signatureHeader,
      jobRequest.api_base
    );
    if (!verifyResult.valid) {
      return c.json<JobResponse>(
        { accepted: false, error: verifyResult.error ?? 'Invalid signature' },
        401
      );
    }

    // 3. Validate required fields
    if (!jobRequest.job_id || !jobRequest.target || !jobRequest.job_collection) {
      return c.json<JobResponse>(
        { accepted: false, error: 'Missing required fields' },
        400
      );
    }

    // 4. Check API key is configured
    if (!env.ARKE_API_KEY) {
      return c.json<JobResponse>(
        { accepted: false, error: 'Agent not configured', retry_after: 60 },
        503
      );
    }

    // 5. Optional pre-processing
    if (config.preProcess) {
      try {
        jobRequest = await config.preProcess(jobRequest, env);
      } catch (err) {
        return c.json<JobResponse>(
          {
            accepted: false,
            error: err instanceof Error ? err.message : 'Pre-processing failed',
          },
          400
        );
      }
    }

    // 6. Get or create DO for this job
    const doNamespace = env[config.doBindingName] as DurableObjectNamespace;
    const doId = doNamespace.idFromName(jobRequest.job_id);
    const stub = doNamespace.get(doId);

    // 7. Dispatch to DO
    try {
      const doResponse = await stub.fetch('https://do/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          job_id: jobRequest.job_id,
          target: jobRequest.target,
          job_collection: jobRequest.job_collection,
          api_base: jobRequest.api_base,
          expires_at: jobRequest.expires_at,
          network: jobRequest.network,
          input: jobRequest.input,
        }),
      });

      const result = (await doResponse.json()) as JobResponse;
      return c.json(result, doResponse.ok ? 200 : 400);
    } catch (err) {
      console.error(`[${env.AGENT_ID}] DO dispatch error:`, err);
      return c.json<JobResponse>(
        {
          accepted: false,
          error: err instanceof Error ? err.message : 'Internal error',
        },
        500
      );
    }
  });

  // ===========================================================================
  // GET /status/:job_id
  // ===========================================================================

  app.get('/status/:job_id', async (c) => {
    const env = c.env;
    const jobId = c.req.param('job_id');

    const doNamespace = env[config.doBindingName] as DurableObjectNamespace;
    const doId = doNamespace.idFromName(jobId);
    const stub = doNamespace.get(doId);

    try {
      const doResponse = await stub.fetch('https://do/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status' }),
      });

      const result = await doResponse.json();
      return c.json(result, doResponse.ok ? 200 : 404);
    } catch (err) {
      console.error(`[${env.AGENT_ID}] Status fetch error:`, err);
      return c.json({ error: 'Job not found' }, 404);
    }
  });

  // ===========================================================================
  // GET /.well-known/arke-verification
  // Used during agent registration to verify endpoint ownership
  // ===========================================================================

  app.get('/.well-known/arke-verification', (c) => {
    const token = c.env.ARKE_VERIFY_TOKEN;
    // Use ARKE_VERIFY_AGENT_ID (set during registration) or fall back to AGENT_ID
    const agentId = c.env.ARKE_VERIFY_AGENT_ID || c.env.AGENT_ID;

    if (!token) {
      return c.json(
        { error: 'Verification not configured' },
        404
      );
    }

    return c.json({
      verification_token: token,
      agent_id: agentId,
      timestamp: Date.now(),
    });
  });

  // ===========================================================================
  // Fallback
  // ===========================================================================

  app.all('*', (c) => {
    return c.json(
      {
        error: 'Not found',
        endpoints: {
          health: 'GET /health',
          process: 'POST /process',
          status: 'GET /status/:job_id',
          verification: 'GET /.well-known/arke-verification',
        },
      },
      404
    );
  });

  return app;
}
