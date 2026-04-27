// Tiny wrapper around EventSource with automatic reconnect semantics.
// EventSource reconnects on its own; we just handle JSON parsing and
// push new events to the caller.

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');

export function openSyncStream(onEvent, onError) {
  const es = new EventSource(`${API_BASE}/api/events/stream`, { withCredentials: false });

  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch (err) {
      // Ignore malformed messages; never kill the stream
      console.warn('[sse] parse error', err);
    }
  };

  es.onerror = (e) => {
    if (onError) onError(e);
  };

  return () => es.close();
}
