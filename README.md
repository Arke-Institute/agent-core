# @arke-institute/agent-core

Shared infrastructure for Arke agents - Durable Objects, routing, logging, and utilities.

## Installation

```bash
npm install @arke-institute/agent-core
```

## Overview

This package provides the foundation for building Arke agents that can handle long-running jobs using Cloudflare Durable Objects:

- **BaseAgentDO**: Abstract Durable Object class with alarm-based processing
- **createAgentRouter**: Factory for creating Hono routers with standard endpoints
- **Signature verification**: Ed25519 signature verification for Arke requests
- **Logging**: Structured job logging with persistence to Arke
- **Dispatcher**: Utilities for invoking agents and polling their status

## Usage

### 1. Create your Durable Object

Extend `BaseAgentDO` and implement the required methods:

```typescript
import {
  BaseAgentDO,
  BaseJobState,
  AlarmState,
  StartRequest,
  JobResponse,
  BaseStatusResponse,
} from '@arke-institute/agent-core';

interface MyJobState extends BaseJobState {
  // Add your custom state fields
  customField: string;
}

interface MyEnv extends BaseAgentEnv {
  MY_AGENT_JOBS: DurableObjectNamespace;
}

export class MyAgentJob extends BaseAgentDO<MyJobState, MyEnv> {
  protected async handleStart(request: StartRequest): Promise<JobResponse> {
    // Initialize job state
    const state: MyJobState = {
      job_id: request.job_id,
      status: 'pending',
      // ... other fields
    };
    await this.saveState(state);
    await this.scheduleImmediateAlarm();
    return { accepted: true, job_id: request.job_id };
  }

  protected async processAlarm(state: MyJobState, alarmState: AlarmState): Promise<boolean> {
    // Process one unit of work
    // Return true to continue, false when done
    return false;
  }

  protected getStatusResponse(state: MyJobState): BaseStatusResponse {
    return {
      job_id: state.job_id,
      status: state.status,
      // ... other fields
    };
  }
}
```

### 2. Create your router

Use `createAgentRouter` to create a Hono router with standard endpoints:

```typescript
import { createAgentRouter } from '@arke-institute/agent-core';

const app = createAgentRouter<MyEnv>({
  doBindingName: 'MY_AGENT_JOBS',
  healthData: (env) => ({
    custom: 'data',
  }),
});

export default app;
export { MyAgentJob };
```

### 3. Configure wrangler.jsonc

```jsonc
{
  "name": "my-agent",
  "main": "src/index.ts",
  "compatibility_date": "2024-12-01",
  "compatibility_flags": ["nodejs_compat"],

  "durable_objects": {
    "bindings": [
      {
        "name": "MY_AGENT_JOBS",
        "class_name": "MyAgentJob"
      }
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_classes": ["MyAgentJob"]
    }
  ]
}
```

## API Reference

### BaseAgentDO

Abstract class for Durable Object-based agents.

**Protected Methods to Implement:**
- `handleStart(request)`: Initialize job state on new request
- `processAlarm(state, alarmState)`: Process one unit of work
- `getStatusResponse(state)`: Format status for client

**Protected Helpers:**
- `getState()` / `saveState(state)`: Manage job state
- `getAlarmState()` / `saveAlarmState(state)`: Manage alarm state
- `scheduleAlarm(delayMs)` / `scheduleImmediateAlarm()`: Schedule alarms
- `failJob(state, code, message)` / `completeJob(state, result)`: Finalize jobs
- `getLogger()`: Get JobLogger instance

### createAgentRouter

Factory for creating Hono routers with standard endpoints:
- `GET /health`: Health check
- `POST /process`: Accept new jobs (with signature verification)
- `GET /status/:job_id`: Query job status

### dispatchToAgent

Invoke another agent via the Arke API:

```typescript
const result = await dispatchToAgent(client, agentId, {
  target: 'collection_id',
  jobCollection: 'job_collection_id',
  input: { /* agent-specific input */ },
});
```

### pollAgentStatus

Poll an agent's status endpoint:

```typescript
const result = await pollAgentStatus(endpoint, jobId);
if (result.done) {
  console.log(result.status, result.result);
}
```

### JobLogger

Structured logging during job execution:

```typescript
const logger = new JobLogger('my-agent');
logger.info('Processing started', { count: 10 });
logger.success('Entity completed', { entityId: '...' });
logger.error('Failed', { error: '...' });
```

### writeJobLog

Write job log to Arke job collection:

```typescript
await writeJobLog(client, jobCollectionId, {
  job_id: '...',
  agent_id: '...',
  status: 'done',
  entries: logger.getEntries(),
});
```

## License

MIT
