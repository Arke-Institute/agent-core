/**
 * Shared types for Arke agents
 *
 * These types form the foundation for all agent implementations:
 * - Pipeline: sequential stage execution
 * - Orchestrator: parallel entity processing with fan-out
 * - Agent: single entity/task processing
 */

// =============================================================================
// Network
// =============================================================================

export type Network = 'test' | 'main';

// =============================================================================
// Job Request (what Arke sends to agents)
// =============================================================================

/**
 * Base job request from Arke API.
 * All agents receive this structure, with agent-specific input.
 */
export interface BaseJobRequest<TInput = Record<string, unknown>> {
  job_id: string;
  target: string;
  job_collection: string;
  input?: TInput;
  api_base: string;
  expires_at: string;
  network: Network;
}

// =============================================================================
// Work Item Status (stages, entities, or tasks)
// =============================================================================

export type WorkItemStatus =
  | 'pending'
  | 'dispatched'
  | 'polling'
  | 'running'
  | 'done'
  | 'error'
  | 'skipped';

/**
 * Base tracking for any work item (stage, entity, task).
 */
export interface BaseWorkItemState {
  status: WorkItemStatus;
  sub_job_id?: string;
  attempts: number;
  started_at?: string;
  completed_at?: string;
  error?: string;
  result?: Record<string, unknown>;
}

// =============================================================================
// Job Progress
// =============================================================================

/**
 * Aggregate progress counters.
 * Different agent types may use different subsets.
 */
export interface JobProgress {
  total: number;
  pending: number;
  running?: number;
  dispatched?: number;
  done: number;
  error: number;
  skipped?: number;
}

// =============================================================================
// Job State (stored in DO storage)
// =============================================================================

export type JobStatus = 'pending' | 'running' | 'done' | 'error';

/**
 * Base job state stored in Durable Object storage.
 * Extended by each agent type with specific work item tracking.
 */
export interface BaseJobState {
  job_id: string;
  status: JobStatus;

  // Job context (from request)
  target: string;
  job_collection: string;
  api_base: string;
  expires_at: string;
  network: Network;

  // Aggregate progress
  progress: JobProgress;

  // Timing
  started_at: string;
  completed_at?: string;

  // Final result/error
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

/**
 * Runtime configuration for job processing.
 */
export interface JobConfig {
  max_retries: number;
  poll_interval_ms: number;
  poll_timeout_ms: number;
  // Agent-specific config can extend this
  [key: string]: unknown;
}

// =============================================================================
// Alarm State (for DO alarm-based processing)
// =============================================================================

export type AlarmPhase = 'dispatch' | 'poll' | 'process' | 'complete';

export interface AlarmState {
  phase: AlarmPhase;
  poll_start_time?: number;
  current_index?: number;
  // Agent-specific alarm state can extend this
  [key: string]: unknown;
}

// =============================================================================
// Job Responses
// =============================================================================

export interface JobAcceptResponse {
  accepted: true;
  job_id: string;
}

export interface JobRejectResponse {
  accepted: false;
  error: string;
  retry_after?: number;
}

export type JobResponse = JobAcceptResponse | JobRejectResponse;

// =============================================================================
// Status Response
// =============================================================================

export interface BaseStatusResponse {
  job_id: string;
  status: JobStatus;
  progress: JobProgress;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  started_at: string;
  completed_at?: string;
}

// =============================================================================
// Signature Verification
// =============================================================================

export interface SigningKeyInfo {
  public_key: string;
  algorithm: string;
  key_id: string;
}

export interface VerifyResult {
  valid: boolean;
  error?: string;
}

// =============================================================================
// Dispatch & Poll
// =============================================================================

export interface DispatchResult {
  success: boolean;
  sub_job_id?: string;
  error?: string;
}

export interface PollResult {
  done: boolean;
  status: 'running' | 'done' | 'error';
  result?: Record<string, unknown>;
  error?: string;
}

// =============================================================================
// Log Entry
// =============================================================================

export type LogLevel = 'info' | 'warning' | 'error' | 'success';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Job Log (written to Arke on completion)
// =============================================================================

export interface JobLog {
  job_id: string;
  agent_id: string;
  agent_version: string;
  started_at: string;
  completed_at: string;
  status: 'done' | 'error';
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  entries: LogEntry[];
  // Agent-specific data (stage_results, entity_results, etc.)
  [key: string]: unknown;
}

// =============================================================================
// Environment (base for all agents)
// =============================================================================

export interface BaseAgentEnv {
  ARKE_API_KEY: string;
  ARKE_API_BASE: string;
  AGENT_ID: string;
  AGENT_VERSION: string;
}

// =============================================================================
// DO Request Types
// =============================================================================

export interface StartRequest<TInput = Record<string, unknown>> {
  action: 'start';
  job_id: string;
  target: string;
  job_collection: string;
  api_base: string;
  expires_at: string;
  network: Network;
  input?: TInput;
}

export interface StatusRequest {
  action: 'status';
}

export type DORequest<TInput = Record<string, unknown>> =
  | StartRequest<TInput>
  | StatusRequest;
