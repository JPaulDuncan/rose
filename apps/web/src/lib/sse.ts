/**
 * Streams SSE events from a job endpoint. Calls `onEvent` for each parsed event,
 * returns a disposer.
 */
export function streamJob(
  jobId: string,
  token: string,
  onEvent: (ev: unknown) => void,
): () => void {
  // EventSource cannot send Authorization headers, so the API also accepts ?access_token=
  const url = `/api/jobs/${jobId}/stream?access_token=${encodeURIComponent(token)}`;
  const es = new EventSource(url, { withCredentials: true });
  es.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data));
    } catch {
      // ignore malformed
    }
  };
  es.onerror = () => {
    es.close();
  };
  return () => es.close();
}
