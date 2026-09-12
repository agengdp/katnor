import type { Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { subscribeToEvents } from '@katnor/db';

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
 */
export function startEventsWebSocketServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: EVENTS_WS_PATH });

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
