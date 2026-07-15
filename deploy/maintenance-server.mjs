import http from 'node:http';

const host = process.env.MAINTENANCE_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.PORT || '43821', 10);

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#090909">
  <title>Update in progress</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; overflow: hidden; background: #090909; color: #f5f5f5; }
    body::before { content: ""; position: fixed; width: 34rem; height: 34rem; border-radius: 50%; background: rgba(159, 223, 95, .13); filter: blur(110px); transform: translate(-38vw, -30vh); }
    main { width: min(90vw, 34rem); padding: 3rem; text-align: center; border: 1px solid #292929; border-radius: 1.75rem; background: rgba(18, 18, 18, .92); box-shadow: 0 2rem 7rem rgba(0, 0, 0, .5); }
    .mark { width: 4.25rem; height: 4.25rem; margin: 0 auto 1.5rem; display: grid; place-items: center; border-radius: 1.25rem; background: #9fdf5f; color: #0b1305; font-size: 2rem; font-weight: 800; box-shadow: 0 0 2.5rem rgba(159, 223, 95, .25); }
    h1 { margin: 0; font-size: clamp(1.75rem, 6vw, 2.5rem); letter-spacing: -.045em; }
    p { margin: 1rem auto 0; max-width: 25rem; color: #a6a6a6; font-size: 1.05rem; line-height: 1.6; }
    .status { margin-top: 2rem; display: inline-flex; align-items: center; gap: .65rem; color: #d7d7d7; font-size: .9rem; }
    .dot { width: .6rem; height: .6rem; border-radius: 50%; background: #9fdf5f; animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .3; transform: scale(.75); } }
    @media (max-width: 520px) { main { padding: 2.25rem 1.5rem; } }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">S</div>
    <h1>Update in progress</h1>
    <p>We’re making Synapsis better. We’ll be right back!</p>
    <div class="status"><span class="dot"></span>Checking for the node…</div>
  </main>
  <script>
    setInterval(async () => {
      try {
        const response = await fetch('/api/health', { cache: 'no-store' });
        if (response.ok) location.reload();
      } catch {}
    }, 5000);
  </script>
</body>
</html>`;

const server = http.createServer((request, response) => {
    response.writeHead(503, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(page),
        'Cache-Control': 'no-store, max-age=0',
        'Retry-After': '30',
        'X-Robots-Tag': 'noindex',
    });
    if (request.method === 'HEAD') response.end();
    else response.end(page);
});

server.listen(port, host, () => {
    console.log(`Synapsis maintenance page listening on http://${host}:${port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
