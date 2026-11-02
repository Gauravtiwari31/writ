// Server-Sent Events writer for GET /v1/stream (and any other live view). Frames follow
// @writ/core/api events.ts: unnamed messages with `id:` and one JSON `data:` line, plus a comment
// heartbeat. Cache-Control: no-transform and X-Accel-Buffering: no keep proxies (the Wallet's /gw
// rewrite, Render) from buffering or compressing the stream.
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md).
import { SSE_HEARTBEAT_MS, type StreamMessage } from "@writ/core/api";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface SseChannel {
  send(message: StreamMessage): void;
  comment(text: string): void;
  close(): void;
  readonly closed: boolean;
  /** Runs once when the client disconnects or close() is called. */
  onClose(listener: () => void): void;
}

export function openSse(request: FastifyRequest, reply: FastifyReply, options: { heartbeatMs?: number } = {}): SseChannel {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  raw.write(": connected\n\n");

  let closed = false;
  const listeners: (() => void)[] = [];
  const heartbeat = setInterval(() => {
    if (!closed) raw.write(": ping\n\n");
  }, options.heartbeatMs ?? SSE_HEARTBEAT_MS);
  heartbeat.unref();

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const listener of listeners.splice(0)) {
      try {
        listener();
      } catch (error) {
        request.log.warn({ err: error }, "sse close listener failed");
      }
    }
    raw.end();
  };
  request.raw.on("close", close);

  return {
    send(message) {
      if (closed) return;
      // JSON.stringify escapes newlines, so one data: line always holds the whole message.
      raw.write(`id: ${message.id}\ndata: ${JSON.stringify(message)}\n\n`);
    },
    comment(text) {
      if (closed) return;
      raw.write(`: ${text.replace(/[\r\n]+/g, " ")}\n\n`);
    },
    close,
    get closed() {
      return closed;
    },
    onClose(listener) {
      if (closed) listener();
      else listeners.push(listener);
    },
  };
}
