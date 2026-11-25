import { useEffect, useRef, useState } from 'react';

export type LiveEvent = { seq: number; type: string; contact?: string; [k: string]: unknown };

/**
 * WebSocket to /ws?workspace=. Reconnects with backoff and asks for ?after=<last seq seen>,
 * so events that happened while disconnected are replayed and nothing is missed.
 */
export function useLive(workspace: string | null, onEvent: (e: LiveEvent) => void, onReconnect: () => void) {
  const [connected, setConnected] = useState(false);
  const handlers = useRef({ onEvent, onReconnect });
  handlers.current = { onEvent, onReconnect };

  useEffect(() => {
    if (!workspace) return;
    let lastSeq: number | null = null;
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const after = lastSeq === null ? '' : `&after=${lastSeq}`;
      ws = new WebSocket(`${proto}://${location.host}/ws?workspace=${encodeURIComponent(workspace)}${after}`);

      ws.onopen = () => {
        if (retry > 0) handlers.current.onReconnect(); // safety net: refresh what is on screen
        retry = 0;
        setConnected(true);
      };
      ws.onmessage = (m) => {
        try {
          const e = JSON.parse(m.data) as LiveEvent;
          if (typeof e.seq !== 'number' || (lastSeq !== null && e.seq <= lastSeq)) return;
          lastSeq = e.seq;
          handlers.current.onEvent(e);
        } catch {
          /* ignore frames that are not JSON */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (stopped) return;
        const delay = Math.min(500 * 2 ** retry++, 8000);
        timer = setTimeout(connect, delay);
      };
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [workspace]);

  return connected;
}
