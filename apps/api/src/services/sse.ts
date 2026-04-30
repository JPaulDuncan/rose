import { EventEmitter } from 'node:events';
import type { JobProgressEvent } from '@rose/shared';

/**
 * In-process pub/sub for SSE updates keyed by jobId. The worker publishes via
 * BullMQ events; the API forwards them through this bus into open SSE streams.
 */
class JobEventBus extends EventEmitter {
  publish(jobId: string, ev: JobProgressEvent): void {
    this.emit(jobId, ev);
    this.emit('*', ev);
  }
}

export const jobEvents = new JobEventBus();
jobEvents.setMaxListeners(1024);
