// In-process event bus feeding GET /v1/stream (SSE). Tenant-scoped: a subscriber only ever sees its
// own tenant's events. Events are published AFTER the transaction that produced them commits (the
// unit of work does this), or directly by the agent-run runner for timeline rows. Each tenant keeps
// a bounded replay buffer for Last-Event-ID reconnects; ids embed a boot id, so an id from before a
// restart is reported as unknown and the client refetches state.
//
// One gateway instance runs on Render, so in-process fan-out is enough. FROZEN for the parallel build.
import { randomBytes } from "node:crypto";
import { StreamEventSchema, type StreamEvent, type StreamMessage } from "@writ/core/api";

export type StreamListener = (message: StreamMessage) => void;

export interface EventBus {
  /** Validates against StreamEventSchema; an invalid event is logged and dropped (null), never sent. */
  publish(tenantId: string, event: StreamEvent): StreamMessage | null;
  subscribe(tenantId: string, listener: StreamListener): () => void;
  /** Buffered messages after `lastEventId`, oldest first; null when the id is unknown or already evicted. */
  since(tenantId: string, lastEventId: string): StreamMessage[] | null;
}

export interface EventBusOptions {
  bufferSize?: number;
  clock?: () => Date;
  onInvalid?: (detail: { tenantId: string; type: unknown; issues: string }) => void;
}

export function createEventBus(options: EventBusOptions = {}): EventBus {
  const bootId = randomBytes(6).readUIntBE(0, 6).toString(36).slice(0, 10);
  const bufferSize = options.bufferSize ?? 500;
  const clock = options.clock ?? (() => new Date());
  const buffers = new Map<string, StreamMessage[]>();
  const listeners = new Map<string, Set<StreamListener>>();
  let counter = 0;

  return {
    publish(tenantId, event) {
      const parsed = StreamEventSchema.safeParse(event);
      if (!parsed.success) {
        options.onInvalid?.({ tenantId, type: (event as { type?: unknown }).type, issues: parsed.error.message.slice(0, 500) });
        return null;
      }
      counter += 1;
      const message: StreamMessage = { id: `${bootId}-${counter}`, at: clock().toISOString(), event: parsed.data };
      const buffer = buffers.get(tenantId) ?? [];
      buffer.push(message);
      if (buffer.length > bufferSize) buffer.splice(0, buffer.length - bufferSize);
      buffers.set(tenantId, buffer);
      for (const listener of listeners.get(tenantId) ?? []) {
        try {
          listener(message);
        } catch {
          // A broken subscriber must not stop delivery to the others.
        }
      }
      return message;
    },
    subscribe(tenantId, listener) {
      const set = listeners.get(tenantId) ?? new Set<StreamListener>();
      set.add(listener);
      listeners.set(tenantId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(tenantId);
      };
    },
    since(tenantId, lastEventId) {
      const buffer = buffers.get(tenantId) ?? [];
      const index = buffer.findIndex((message) => message.id === lastEventId);
      return index === -1 ? null : buffer.slice(index + 1);
    },
  };
}
