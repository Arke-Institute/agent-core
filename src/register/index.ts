/**
 * @arke-institute/agent-core/register
 *
 * Agent registration utilities for development and deployment.
 * This module runs at development time (scripts), not in the worker runtime.
 *
 * @example
 * ```typescript
 * // scripts/register.ts
 * import { runCli } from '@arke-institute/agent-core/register';
 * runCli();
 * ```
 */

export * from './types.js';
export * from './config.js';
export { registerAgent, runCli } from './register.js';
