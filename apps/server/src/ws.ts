import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { subscribeToEvents } from '@katnor/db';
import { readCookie, SESSION_COOKIE_NAME, verifySessionToken } from './auth.js';

const EVENTS_WS_PATH = '/ws/events';

/**
 * Starts the live-events WebSocket server, attached to the same underlying
 * `http.Server` the Hono app is served from (so the dashboard reaches both
 * tRPC and the event stream on one port).
 *
 * Subscribes to the Postgres `LISTEN/NOTIFY` event bus (`subscribeToEvents`
 * from @katnor/db, see its src/listen.ts) exactly once here at startup -
 * not once per connected client - and fans every event out to every
 * currently-connected client whose socket is OPEN. A client that connects
 * later simply starts receiving events from that point on; there is no
 * backlog/replay in v1.
 *
 * Authenticated on upgrade, with the same `katnor_session` cookie the rest
 * of the API uses. This stream carries every row inserted into the `event`
 * table - messages, run steps, approvals, spend - so an open socket here
 * would leak the whole company's activity no matter how well `/trpc/*` was
 * locked down.
 *
 * `noServer` plus a manual `upgrade` handler, rather than passing
 * `{ server, path }` and rejecting inside `connection`: by the time a
 * `connection` fires the handshake has already succeeded, so the only way
 * to refuse is to close an established socket. Deciding during `upgrade`
 * lets an unauthenticated client get a plain `401` it can actually act on.
 */
export function startEventsWebSocketServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  function isAuthenticated(request: IncomingMessage): boolean {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
    return verifySessionToken(token) !== null;
  }

  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // `request.url` is a path, not an absolute URL, so it needs a base to
    // parse against - the value is irrelevant, only the pathname is read.
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    // Anything that is not this endpoint is left alone rather than
    // destroyed: another upgrade handler may legitimately own it, and
    // stealing its socket would break it.
    if (pathname !== EVENTS_WS_PATH) return;

    if (!isAuthenticated(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit('connection', client, request);
    });
  });

  wss.on('connection', (socket) => {
    socket.on('error', (err) => {
      console.error('[ws] client socket error:', err);
    });
  });

  wss.on('error', (err) => {
    console.error('[ws] server error:', err);
  });

  const subscription = subscribeToEvents((row) => {
    const payload = JSON.stringify(row);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  });

  wss.on('close', () => {
    void subscription.close();
  });

  console.log(`[ws] events WebSocket server listening on path "${EVENTS_WS_PATH}"`);
  return wss;
}
