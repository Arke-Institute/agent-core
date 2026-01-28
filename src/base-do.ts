/**
 * Base Durable Object class for Arke agents
 *
 * Provides common functionality for all agent types:
 * - State management via SQLite storage (_agent_kv table)
 * - Alarm-based processing
 * - Request routing (start/status)
 * - Error handling and recovery
 *
 * Requires SQLite-backed Durable Objects (new_sqlite_classes in wrangler.jsonc).
 *
 * Subclasses implement:
 * - handleStart(): Initialize job state
 * - processAlarm(): Process one unit of work
 * - getStatusResponse(): Format status for client
 */

import { DurableObject } from 'cloudflare:workers';
import type {
  BaseJobState,
  AlarmState,
  JobResponse,
  BaseStatusResponse,
  StartRequest,
  DORequest,
  BaseAgentEnv,
} from './types';
import { JobLogger } from './logger';

// =============================================================================
// Abstract Base Class
// =============================================================================

/**
 * Abstract base class for Arke agent Durable Objects.
 *
 * Handles common patterns:
 * - fetch() routes to handleStart() or handleStatus()
 * - alarm() calls processAlarm() with error recovery
 * - State and alarm state management via SQLite (_agent_kv table)
 *
 * @template TState - Job state type (extends BaseJobState)
 * @template TEnv - Environment type (extends BaseAgentEnv)
 * @template TInput - Input type for job requests
 */
export abstract class BaseAgentDO<
  TState extends BaseJobState = BaseJobState,
  TEnv extends BaseAgentEnv = BaseAgentEnv,
  TInput = Record<string, unknown>,
> extends DurableObject<TEnv> {
  protected logger: JobLogger | null = null;

  // Storage keys
  protected readonly STATE_KEY = 'state';
  protected readonly ALARM_STATE_KEY = 'alarm_state';

  // SQLite schema initialization flag
  private _schemaInit = false;

  constructor(ctx: DurableObjectState, env: TEnv) {
    super(ctx, env);
  }

  // ===========================================================================
  // SQLite Schema
  // ===========================================================================

  /**
   * Ensure the _agent_kv table exists in SQLite storage.
   * Safe to call multiple times -- uses IF NOT EXISTS and an in-memory flag.
   */
  private ensureSchema(): void {
    if (this._schemaInit) return;
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS _agent_kv (key TEXT PRIMARY KEY, value TEXT)'
    );
    this._schemaInit = true;
  }

  // ===========================================================================
  // Abstract Methods (subclasses must implement)
  // ===========================================================================

  /**
   * Handle a start request - initialize job state.
   *
   * Called when the agent receives a new job request.
   * Should validate input, create initial state, and schedule first alarm.
   */
  protected abstract handleStart(
    request: StartRequest<TInput>
  ): Promise<JobResponse>;

  /**
   * Process one alarm tick - do one unit of work.
   *
   * Called by alarm() with current state.
   * Should update state, potentially schedule next alarm.
   * Return true if processing should continue, false if done.
   */
  protected abstract processAlarm(
    state: TState,
    alarmState: AlarmState
  ): Promise<boolean>;

  /**
   * Get status response for client.
   *
   * Called when status is requested.
   * Format state into appropriate response.
   */
  protected abstract getStatusResponse(state: TState): BaseStatusResponse;

  // ===========================================================================
  // Fetch Handler
  // ===========================================================================

  async fetch(request: Request): Promise<Response> {
    try {
      const body = (await request.json()) as DORequest<TInput>;

      if (body.action === 'start') {
        const response = await this.handleStart(body);
        return Response.json(response);
      }

      if (body.action === 'status') {
        const state = await this.getState();
        if (!state) {
          return Response.json({ error: 'Job not found' }, { status: 404 });
        }
        const response = this.getStatusResponse(state);
        return Response.json(response);
      }

      return Response.json({ error: 'Unknown action' }, { status: 400 });
    } catch (err) {
      console.error(`[${this.env.AGENT_ID}] DO fetch error:`, err);
      return Response.json(
        { error: err instanceof Error ? err.message : 'Internal error' },
        { status: 500 }
      );
    }
  }

  // ===========================================================================
  // Alarm Handler
  // ===========================================================================

  async alarm(): Promise<void> {
    const state = await this.getState();
    if (!state) {
      console.error(`[${this.env.AGENT_ID}] Alarm fired but no state found`);
      return;
    }

    // Check if job is already complete
    if (state.status === 'done' || state.status === 'error') {
      console.log(
        `[${this.env.AGENT_ID}] Job ${state.job_id} already complete, skipping alarm`
      );
      return;
    }

    // Get or create alarm state
    let alarmState = await this.getAlarmState();
    if (!alarmState) {
      alarmState = { phase: 'dispatch' };
    }

    try {
      const shouldContinue = await this.processAlarm(state, alarmState);

      if (!shouldContinue) {
        // Job is complete, no more alarms
        console.log(`[${this.env.AGENT_ID}] Job ${state.job_id} processing complete`);
      }
    } catch (err) {
      console.error(`[${this.env.AGENT_ID}] Alarm error:`, err);

      // Retry after 5 seconds on error
      await this.scheduleAlarm(5000);
    }
  }

  // ===========================================================================
  // State Management (SQLite-backed)
  // ===========================================================================

  /**
   * Get current job state from SQLite storage.
   */
  protected async getState(): Promise<TState | undefined> {
    this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec('SELECT value FROM _agent_kv WHERE key = ?', this.STATE_KEY)
      .toArray();
    if (rows.length === 0) return undefined;
    return JSON.parse(rows[0].value as string) as TState;
  }

  /**
   * Save job state to SQLite storage.
   * Automatically sets updated_at timestamp.
   */
  protected async saveState(state: TState): Promise<void> {
    // Auto-set updated_at timestamp for freshness tracking
    (state as BaseJobState).updated_at = new Date().toISOString();
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO _agent_kv (key, value) VALUES (?, ?)',
      this.STATE_KEY,
      JSON.stringify(state)
    );
  }

  /**
   * Get alarm state from SQLite storage.
   */
  protected async getAlarmState(): Promise<AlarmState | undefined> {
    this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec('SELECT value FROM _agent_kv WHERE key = ?', this.ALARM_STATE_KEY)
      .toArray();
    if (rows.length === 0) return undefined;
    return JSON.parse(rows[0].value as string) as AlarmState;
  }

  /**
   * Save alarm state to SQLite storage.
   */
  protected async saveAlarmState(alarmState: AlarmState): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO _agent_kv (key, value) VALUES (?, ?)',
      this.ALARM_STATE_KEY,
      JSON.stringify(alarmState)
    );
  }

  /**
   * Clear alarm state from SQLite storage.
   */
  protected async clearAlarmState(): Promise<void> {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      'DELETE FROM _agent_kv WHERE key = ?',
      this.ALARM_STATE_KEY
    );
  }

  // ===========================================================================
  // Alarm Scheduling
  // ===========================================================================

  /**
   * Schedule an alarm to fire after the specified delay.
   *
   * @param delayMs - Delay in milliseconds
   */
  protected async scheduleAlarm(delayMs: number): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  /**
   * Schedule an immediate alarm (100ms delay).
   */
  protected async scheduleImmediateAlarm(): Promise<void> {
    await this.scheduleAlarm(100);
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Check if job has expired.
   */
  protected isExpired(state: TState): boolean {
    const expiresAt = new Date(state.expires_at).getTime();
    return Date.now() > expiresAt;
  }

  /**
   * Create or get logger instance.
   */
  protected getLogger(): JobLogger {
    if (!this.logger) {
      this.logger = new JobLogger(this.env.AGENT_ID);
    }
    return this.logger;
  }

  /**
   * Update job status to error and save.
   */
  protected async failJob(
    state: TState,
    code: string,
    message: string
  ): Promise<void> {
    state.status = 'error';
    state.completed_at = new Date().toISOString();
    state.error = { code, message };
    await this.saveState(state);
  }

  /**
   * Update job status to done and save.
   */
  protected async completeJob(
    state: TState,
    result?: Record<string, unknown>
  ): Promise<void> {
    state.status = 'done';
    state.completed_at = new Date().toISOString();
    if (result) {
      state.result = result;
    }
    await this.saveState(state);
  }
}
