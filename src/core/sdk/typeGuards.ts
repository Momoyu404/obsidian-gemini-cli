import type { StreamChunk } from '../types';
import type { SessionInitEvent, TransformEvent } from './types';

export function isSessionInitEvent(event: TransformEvent): event is SessionInitEvent {
  return event.type === 'session_init';
}

export function isStreamChunk(event: TransformEvent): event is StreamChunk {
  return event.type !== 'session_init';
}
