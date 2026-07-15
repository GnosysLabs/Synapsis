export function renderStuffboxPopupResponse(origin: string, success: boolean, message: string): string {
  const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
  const payload = safeJson({ type: 'synapsis:stuffbox', success, message });
  const targetOrigin = safeJson(origin);

  return `<!doctype html><html><head><meta charset="utf-8"><title>Stuffbox</title></head><body>
    <p>${success ? 'Stuffbox connected. Returning to Synapsis…' : 'Stuffbox could not be connected. Returning to Synapsis…'}</p>
    <script>
      const payload = ${payload};
      try {
        if (window.opener && !window.opener.closed) window.opener.postMessage(payload, ${targetOrigin});
      } catch {}
      try {
        const channel = new BroadcastChannel('synapsis:stuffbox');
        channel.postMessage(payload);
        channel.close();
      } catch {}
      try {
        localStorage.setItem('synapsis:stuffbox:result', JSON.stringify({ ...payload, sentAt: Date.now() }));
      } catch {}
      window.setTimeout(() => window.close(), 250);
    </script>
  </body></html>`;
}
