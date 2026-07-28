import { EventEmitter } from 'node:events';

export function closeEventSink() {
  return Promise.resolve();
}

export function subscribe() {
  return Promise.resolve(new EventEmitter());
}
