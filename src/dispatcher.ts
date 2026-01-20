/**
 * Agent dispatch and polling utilities
 *
 * Provides functions for invoking agents via the Arke API
 * and polling their status endpoints.
 */

import type { ArkeClient } from '@arke-institute/sdk';
import type { DispatchResult, PollResult } from './types';

// =============================================================================
// Dispatch
// =============================================================================

export interface DispatchOptions {
  /** Target collection/entity */
  target: string;
  /** Parent job collection (sub-agent gets its own sub-collection) */
  jobCollection: string;
  /** Input to pass to the agent */
  input?: Record<string, unknown>;
  /** Permission expiry in seconds (default: 2 hours) */
  expiresIn?: number;
}

/**
 * Dispatch a job to an agent via the Arke API.
 *
 * @param client - ArkeClient instance
 * @param agentId - The agent's entity ID
 * @param options - Dispatch options
 * @returns DispatchResult with success status and job_id or error
 */
export async function dispatchToAgent(
  client: ArkeClient,
  agentId: string,
  options: DispatchOptions
): Promise<DispatchResult> {
  try {
    const { data, error } = await client.api.POST('/agents/{id}/invoke', {
      params: { path: { id: agentId } },
      body: {
        target: options.target,
        job_collection: options.jobCollection,
        input: options.input,
        expires_in: options.expiresIn ?? 7200, // 2 hours default
        confirm: true,
      },
    });

    if (error) {
      return { success: false, error: JSON.stringify(error) };
    }

    // Type narrowing for union response
    if (
      data &&
      'error' in data &&
      'status' in data &&
      data.status === 'rejected'
    ) {
      return { success: false, error: (data as { error: string }).error };
    }

    if (
      data &&
      'job_id' in data &&
      'status' in data &&
      data.status === 'started'
    ) {
      return { success: true, sub_job_id: (data as { job_id: string }).job_id };
    }

    return { success: false, error: 'Unexpected response from Arke' };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Dispatch failed',
    };
  }
}

// =============================================================================
// Polling
// =============================================================================

/**
 * Poll an agent's status endpoint once.
 *
 * Use this in alarm-based processing where you poll once per alarm tick.
 *
 * @param endpoint - Agent's base endpoint URL
 * @param jobId - The sub-job ID to check
 * @returns PollResult with status and result/error
 */
export async function pollAgentStatus(
  endpoint: string,
  jobId: string
): Promise<PollResult> {
  const statusUrl = `${endpoint}/status/${jobId}`;

  try {
    const res = await fetch(statusUrl);

    if (!res.ok) {
      // Treat non-OK as still running (might be temporary issue)
      return { done: false, status: 'running' };
    }

    const data = (await res.json()) as {
      status: string;
      result?: Record<string, unknown>;
      error?: { code: string; message: string };
    };

    if (data.status === 'done') {
      return { done: true, status: 'done', result: data.result };
    }

    if (data.status === 'error') {
      return {
        done: true,
        status: 'error',
        error: data.error?.message ?? 'Unknown error',
      };
    }

    // Still pending or running
    return { done: false, status: 'running' };
  } catch {
    // Network error, treat as still running
    return { done: false, status: 'running' };
  }
}

/**
 * Poll an agent's status endpoint until done/error or timeout.
 *
 * Use this for simple synchronous polling (e.g., in waitUntil).
 * For DO-based agents, prefer alarm-based polling with pollAgentStatus().
 *
 * @param endpoint - Agent's base endpoint URL
 * @param jobId - The sub-job ID to check
 * @param pollIntervalMs - Interval between polls in milliseconds
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @returns PollResult with final status
 */
export async function pollAgentStatusUntilDone(
  endpoint: string,
  jobId: string,
  pollIntervalMs: number,
  timeoutMs: number
): Promise<PollResult> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const result = await pollAgentStatus(endpoint, jobId);

    if (result.done) {
      return result;
    }

    await sleep(pollIntervalMs);
  }

  // Timeout
  return { done: false, status: 'error', error: 'Polling timeout exceeded' };
}

// =============================================================================
// Utilities
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simple promise pool for limiting concurrency.
 *
 * Use this when processing multiple items in parallel with a concurrency limit.
 */
export class PromisePool {
  private running = 0;
  private queue: Array<() => Promise<void>> = [];

  constructor(private concurrency: number) {}

  async add(fn: () => Promise<void>): Promise<void> {
    if (this.running >= this.concurrency) {
      // Wait for a slot
      await new Promise<void>((resolve) => {
        this.queue.push(async () => {
          await fn();
          resolve();
        });
      });
    } else {
      this.running++;
      try {
        await fn();
      } finally {
        this.running--;
        this.runNext();
      }
    }
  }

  private runNext(): void {
    if (this.queue.length > 0 && this.running < this.concurrency) {
      const next = this.queue.shift()!;
      this.running++;
      next().finally(() => {
        this.running--;
        this.runNext();
      });
    }
  }

  async drain(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0) {
      await sleep(100);
    }
  }
}
