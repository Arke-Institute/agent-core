/**
 * @arke-institute/agent-core
 *
 * Shared infrastructure for Arke agents.
 *
 * This package provides the foundation for building Arke agents:
 * - BaseAgentDO: Abstract Durable Object class for long-running jobs
 * - createAgentRouter: Factory for creating Hono routers with standard endpoints
 * - Signature verification, logging, and dispatch utilities
 *
 * @example
 * ```typescript
 * import {
 *   BaseAgentDO,
 *   createAgentRouter,
 *   JobLogger,
 *   dispatchToAgent,
 * } from '@arke-institute/agent-core';
 *
 * // Create your DO by extending BaseAgentDO
 * export class MyAgentJob extends BaseAgentDO<MyState, MyEnv, MyInput> {
 *   protected async handleStart(request) { ... }
 *   protected async processAlarm(state, alarmState) { ... }
 *   protected getStatusResponse(state) { ... }
 * }
 *
 * // Create the router
 * const app = createAgentRouter({ doBindingName: 'MY_AGENT_JOBS' });
 * export default app;
 * ```
 */

// =============================================================================
// Types
// =============================================================================

export type {
  // Network
  Network,

  // Job Request
  BaseJobRequest,

  // Work Items
  WorkItemStatus,
  BaseWorkItemState,

  // Job State
  JobStatus,
  JobProgress,
  BaseJobState,
  JobConfig,

  // Alarm
  AlarmPhase,
  AlarmState,

  // Responses
  JobAcceptResponse,
  JobRejectResponse,
  JobResponse,
  BaseStatusResponse,

  // Enhanced Status (hierarchical status reporting)
  StageStatus,
  SubJobStatus,
  NestedProgress,
  NestedServiceStatus,
  EnhancedStatusResponse,
  FullPollResponse,

  // Signature
  SigningKeyInfo,
  VerifyResult,

  // Dispatch & Poll
  DispatchResult,
  PollResult,

  // Logging
  LogLevel,
  LogEntry,
  JobLog,

  // Environment
  BaseAgentEnv,

  // DO Requests
  StartRequest,
  StatusRequest,
  DORequest,
} from './types';

// =============================================================================
// Base DO
// =============================================================================

export { BaseAgentDO } from './base-do';

// =============================================================================
// Router
// =============================================================================

export { createAgentRouter } from './router';
export type { AgentRouterConfig } from './router';

// =============================================================================
// Signature Verification
// =============================================================================

export {
  verifyArkeSignature,
  getArkePublicKey,
  parseSignatureHeader,
  clearKeyCache,
} from './verify';

// =============================================================================
// Logging
// =============================================================================

export { JobLogger, writeJobLog } from './logger';

// =============================================================================
// Dispatcher
// =============================================================================

export {
  dispatchToAgent,
  pollAgentStatus,
  pollAgentStatusUntilDone,
  pollAgentStatusFull,
  PromisePool,
} from './dispatcher';
export type { DispatchOptions, FullPollResult } from './dispatcher';

// =============================================================================
// Utilities
// =============================================================================

export {
  sleep,
  withRetry,
  withTimeout,
  createTimeout,
  chunk,
  deferred,
  formatDuration,
  generateId,
} from './utils';
