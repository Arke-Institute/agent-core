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
  /** ISO timestamp of last state modification (auto-set by saveState) */
  updated_at?: string;

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
  /** ISO timestamp of last state modification */
  updated_at?: string;
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
  /** Temporary verification token used during endpoint ownership verification */
  ARKE_VERIFY_TOKEN?: string;
  /** Temporary agent ID used during endpoint ownership verification */
  ARKE_VERIFY_AGENT_ID?: string;
}

// =============================================================================
// Enhanced Status Types (for hierarchical status reporting)
// =============================================================================

/**
 * Status of a processing stage within a multi-stage job.
 * Used by workflows to report progress through their pipeline.
 */
export interface StageStatus {
  /** Stage name (e.g., 'structure', 'description', 'resize', 'ocr') */
  name: string;
  /** Current status of this stage */
  status: 'pending' | 'running' | 'done' | 'skipped' | 'error';
  /** When the stage started processing */
  started_at?: string;
  /** When the stage completed */
  completed_at?: string;
  /** Total items to process in this stage (if applicable) */
  items_total?: number;
  /** Items successfully completed */
  items_done?: number;
  /** Items that failed */
  items_error?: number;
}

/**
 * Status of a dispatched sub-job (service or workflow).
 * Used by workflows/orchestrators to track child jobs.
 */
export interface SubJobStatus {
  /** Unique identifier for this sub-job */
  id: string;
  /** Service or workflow type (e.g., 'structure-extraction', 'text-workflow') */
  service: string;
  /** Entity being processed */
  entity_id: string;
  /** Current status */
  status: WorkItemStatus;
  /** Job ID returned by the sub-agent */
  sub_job_id?: string;
  /** Number of dispatch/poll attempts */
  attempts: number;
  /** When processing started */
  started_at?: string;
  /** When processing completed */
  completed_at?: string;
  /** Error message if failed */
  error?: string;
  /** Nested status from the sub-agent (captured during polling) */
  service_status?: NestedServiceStatus;
}

/**
 * Progress information from a nested operation (e.g., Lambda processing).
 * Provides visibility into long-running sub-tasks.
 */
export interface NestedProgress {
  /** Current processing phase (service-specific, e.g., 'planning', 'extracting') */
  phase: string;
  /** Completion percentage (0-100). Optional - omit if not meaningfully calculable. */
  percent_complete?: number;
  /** Service-specific progress details */
  details?: Record<string, unknown>;
}

/**
 * Snapshot of a sub-agent's status for parent tracking.
 * Captured when polling sub-jobs to provide nested visibility.
 */
export interface NestedServiceStatus {
  /** Sub-agent's job status */
  status: JobStatus;
  /** Sub-agent's current phase (if applicable) */
  phase?: string;
  /** Sub-agent's progress counters */
  progress?: JobProgress;
  /** Nested progress from Lambda or further sub-tasks */
  nested_progress?: NestedProgress;
  /** When this status was captured */
  updated_at: string;
}

/**
 * Enhanced status response with optional detailed breakdowns.
 * Extends BaseStatusResponse with hierarchical status information.
 */
export interface EnhancedStatusResponse extends BaseStatusResponse {
  /** Processing stages with individual status (for multi-stage jobs) */
  stages?: StageStatus[];
  /** Dispatched sub-jobs with their status (for fan-out jobs) */
  sub_jobs?: SubJobStatus[];
  /** Nested progress from Lambda or sub-agent processing */
  nested_progress?: NestedProgress;
  /** Recent errors with context for debugging */
  recent_errors?: Array<{
    /** Identifier for the failed item */
    id: string;
    /** Error message */
    message: string;
    /** When the error occurred */
    timestamp: string;
    /** Additional context (e.g., entity_id, workflow type) */
    context?: Record<string, unknown>;
  }>;
}

/**
 * Full status response from polling (includes all fields for nesting).
 * Used by pollAgentStatusFull() to capture complete sub-agent status.
 */
export interface FullPollResponse extends EnhancedStatusResponse {
  /** Always present in poll responses */
  job_id: string;
  status: JobStatus;
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
