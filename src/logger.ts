/**
 * Job logging for Arke agents
 *
 * Provides structured logging during job execution and writes
 * final logs to the job collection on completion.
 */

import type { ArkeClient } from '@arke-institute/sdk';
import type { LogLevel, LogEntry, JobLog } from './types';

/**
 * Job logger that collects log entries during execution.
 * Entries are written to the job collection on completion.
 */
export class JobLogger {
  private entries: LogEntry[] = [];

  constructor(private agentId: string) {}

  private log(
    level: LogLevel,
    message: string,
    metadata?: Record<string, unknown>
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      metadata,
    };
    this.entries.push(entry);
    console.log(`[${this.agentId}] [${level}] ${message}`, metadata ?? '');
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.log('info', message, metadata);
  }

  warning(message: string, metadata?: Record<string, unknown>): void {
    this.log('warning', message, metadata);
  }

  error(message: string, metadata?: Record<string, unknown>): void {
    this.log('error', message, metadata);
  }

  success(message: string, metadata?: Record<string, unknown>): void {
    this.log('success', message, metadata);
  }

  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }
}

/**
 * Write job log to the job collection.
 *
 * Creates a new file entity in the job collection, then updates the collection
 * to add "contains" relationship with CAS retry.
 */
export async function writeJobLog(
  client: ArkeClient,
  jobCollection: string,
  log: JobLog
): Promise<{ success: boolean; fileId?: string; error?: string }> {
  const filename = `${log.job_id}.json`;

  try {
    // Step 1: Create file in the job collection
    const { data: file, error: createError } = await client.api.POST('/files', {
      body: {
        key: filename,
        collection: jobCollection,
        filename,
        content_type: 'application/json',
        size: 0,
        relationships: [
          { predicate: 'in', peer: jobCollection, peer_type: 'collection' },
        ],
        properties: {
          log_data: log,
        },
        description: `Job log for ${log.job_id}`,
      },
    });

    if (createError || !file) {
      console.error(`[logger] Failed to create log file:`, createError);
      return { success: false, error: 'Failed to create log file' };
    }

    console.log(
      `[logger] Created log file ${file.id} in collection ${jobCollection}`
    );

    // Step 2: Update collection to add "contains" relationship with CAS retry
    const updateResult = await updateCollectionWithContains(
      client,
      jobCollection,
      file.id
    );

    if (!updateResult.success) {
      return { success: false, fileId: file.id, error: updateResult.error };
    }

    return { success: true, fileId: file.id };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[logger] Error writing job log:`, err);
    return { success: false, error: errorMessage };
  }
}

/**
 * Update collection to add "contains" relationship with CAS retry.
 */
async function updateCollectionWithContains(
  client: ArkeClient,
  collectionId: string,
  fileId: string
): Promise<{ success: boolean; error?: string }> {
  const maxRetries = 5;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Get current collection CID
      const { data: collection } = await client.api.GET('/collections/{id}', {
        params: { path: { id: collectionId } },
      });

      if (!collection) {
        console.error(`[logger] Job collection not found: ${collectionId}`);
        return { success: false, error: 'Job collection not found' };
      }

      // Update with contains relationship
      const { error: updateError } = await client.api.PUT('/collections/{id}', {
        params: { path: { id: collectionId } },
        body: {
          expect_tip: collection.cid,
          relationships_add: [
            { predicate: 'contains', peer: fileId, peer_type: 'file' },
          ],
          note: `Added log file ${fileId}`,
        },
      });

      if (updateError) {
        // Check if it's a CAS conflict
        const errorStr = JSON.stringify(updateError);
        if (errorStr.includes('409') || errorStr.includes('Conflict')) {
          if (attempt < maxRetries - 1) {
            const delay = Math.pow(2, attempt) * 100 + Math.random() * 100;
            console.log(`[logger] CAS conflict, retrying in ${delay}ms...`);
            await sleep(delay);
            continue;
          }
        }
        console.error(`[logger] Failed to update collection:`, updateError);
        return { success: false, error: 'Failed to update collection' };
      }

      console.log(
        `[logger] Updated collection ${collectionId} with contains relationship`
      );
      return { success: true };
    } catch (err) {
      console.error(
        `[logger] Error updating collection (attempt ${attempt + 1}):`,
        err
      );
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 100 + Math.random() * 100;
        await sleep(delay);
      }
    }
  }

  console.error(
    `[logger] Failed to update collection after ${maxRetries} retries`
  );
  return { success: false, error: 'Max retries exceeded' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
