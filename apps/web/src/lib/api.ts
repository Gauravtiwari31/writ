"use client";
// The Wallet's only way to the gateway: same-origin /gw/*, so the session cookie stays first-party on this
// host (plan §6.6). Errors keep the gateway's stable code, so screens can react to it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { StreamMessage } from "@writ/core/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const response = await fetch(`/gw${path}`, {
    method,
    credentials: "same-origin",
    headers: method === "POST" ? { "content-type": "application/json" } : {},
    ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let parsed: { error?: string; message?: string } | null;
  try {
    parsed = JSON.parse(text) as { error?: string; message?: string };
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw new ApiError(response.status, parsed?.error ?? "unavailable", parsed?.message ?? "The gateway is not answering. Is it running?");
  }
  return parsed as T;
}

export interface Loaded<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  reload: () => void;
}

export function useLoad<T>(path: string | null): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (path === null) return;
    let live = true;
    api<T>(path)
      .then((value) => {
        if (live) {
          setData(value);
          setError(null);
        }
      })
      .catch((failure: Error) => {
        if (live) setError(failure);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { data, error, loading, reload };
}

/** Live events for this tenant. EventSource reconnects by itself and sends Last-Event-ID. */
export function useStream(onMessage: (message: StreamMessage) => void): void {
  const handler = useRef(onMessage);
  useEffect(() => {
    handler.current = onMessage;
  });
  useEffect(() => {
    const source = new EventSource("/gw/v1/stream");
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        handler.current(JSON.parse(event.data) as StreamMessage);
      } catch {
        // A frame we cannot read is skipped; the next reload shows the truth.
      }
    };
    return () => source.close();
  }, []);
}
