import { EventEmitter } from 'node:events';
import type { RealtimeEvent } from '../../shared/types';

/** In-process pub/sub used by the SSE endpoint. */
export class RuntimeEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  publish(event: Omit<RealtimeEvent, 'at'>): void {
    const payload: RealtimeEvent = { ...event, at: new Date().toISOString() };
    this.emitter.emit('event', payload);
  }

  subscribe(listener: (event: RealtimeEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
