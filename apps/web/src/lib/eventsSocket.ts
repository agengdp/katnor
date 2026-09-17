import { env } from '$env/dynamic/public';

/**
 * A lazy, shared connection to apps/server's `/ws/events` endpoint (see
 * apps/server/src/ws.ts), broadcasting every row inserted into the
 * append-only `event` table (PLAN.md's event bus). Every dashboard page
 * that wants "live" updates (Chat, the kanban board, Runs, Inbox, the
 * Office in a later phase) calls `subscribeToEvents()` rather than each
 * opening its own socket.
 *
 * Deliberately a plain callback pub/sub, not a Svelte store or a
 * `.svelte.ts` runes module - this file has no UI framework dependency, so
 * any component can layer its own `$state` on top of `subscribeToEvents`
 * (see the pattern each page below uses: an `$effect` that subscribes on
 * mount and returns the unsubscribe function as its cleanup).
 */

export interface KatnorEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  occurred_at: string;
  [key: string]: unknown;
}

type Listener = (event: KatnorEvent) => void;

const listeners = new Set<Listener>();
let socket: WebSocket | undefined;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function wsUrl(): string {
  const base = env.PUBLIC_SERVER_URL ?? 'http://localhost:3001';
  return `${base.replace(/^http/, 'ws').replace(/\/+$/, '')}/ws/events`;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delayMs = Math.min(30_000, 1_000 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delayMs);
}

function connect() {
  if (typeof window === 'undefined') return; // no sockets during SSR
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  )
    return;

  try {
    socket = new WebSocket(wsUrl());
  } catch (err) {
    console.error('[eventsSocket] failed to open WebSocket:', err);
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    reconnectAttempt = 0;
  });

  socket.addEventListener('message', (message) => {
    try {
      const parsed = JSON.parse(message.data as string) as KatnorEvent;
      for (const listener of listeners) listener(parsed);
    } catch (err) {
      console.error('[eventsSocket] failed to parse event payload:', err);
    }
  });

  socket.addEventListener('close', () => {
    socket = undefined;
    if (listeners.size > 0) scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    // 'close' always follows 'error' for a WebSocket - no separate handling needed here.
  });
}

/**
 * Subscribes to every live event and returns an unsubscribe function.
 * Opens the shared socket on the first subscriber and lets it go idle
 * (closed, on the server's end, when there's nothing to send) once the
 * last one unsubscribes.
 */
export function subscribeToEvents(listener: Listener): () => void {
  listeners.add(listener);
  connect();
  return () => {
    listeners.delete(listener);
  };
}
