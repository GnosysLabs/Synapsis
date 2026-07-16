import http from 'node:http';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';

const host = process.env.MAINTENANCE_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.PORT || '43821', 10);
const dataDir = process.env.MAINTENANCE_DATA_DIR
    || dirname(process.env.DATABASE_PATH || '/var/lib/synapsis/synapsis.db');
const appDir = process.env.MAINTENANCE_APP_DIR || process.cwd();
const brandingPath = join(dataDir, 'maintenance-branding.json');
const logoPath = join(dataDir, 'maintenance-logo');
const faviconPath = join(dataDir, 'maintenance-favicon');
const defaultLogoPath = join(appDir, 'public', 'logotext.svg');
const defaultFaviconPath = join(appDir, 'public', 'favicon.png');

function validAccent(value) {
    return typeof value === 'string' && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)
        ? value
        : '#9fdf5f';
}

async function captureBranding() {
    const baseUrl = `http://127.0.0.1:${port}`;
    await mkdir(dataDir, { recursive: true });
    const nodeResponse = await fetch(`${baseUrl}/api/node`, { cache: 'no-store' });
    if (!nodeResponse.ok) throw new Error(`Node branding returned HTTP ${nodeResponse.status}`);

    const node = await nodeResponse.json();
    const branding = {
        accentColor: validAccent(node.accentColor),
        externalLogoUrl: typeof node.logoUrl === 'string' && /^https?:\/\//i.test(node.logoUrl)
            ? node.logoUrl
            : null,
        logoContentType: null,
        faviconContentType: null,
    };

    const logoResponse = await fetch(`${baseUrl}/api/node/logo`, { cache: 'no-store' });
    if (logoResponse.ok) {
        const contentType = logoResponse.headers.get('content-type')?.split(';')[0];
        if (contentType?.startsWith('image/')) {
            const logoTempPath = `${logoPath}.tmp`;
            await writeFile(logoTempPath, Buffer.from(await logoResponse.arrayBuffer()));
            await rename(logoTempPath, logoPath);
            branding.logoContentType = contentType;
        } else {
            await rm(logoPath, { force: true });
        }
    } else {
        await rm(logoPath, { force: true });
    }

    const faviconResponse = await fetch(`${baseUrl}/api/favicon`, { cache: 'no-store' });
    if (faviconResponse.ok) {
        const contentType = faviconResponse.headers.get('content-type')?.split(';')[0];
        if (contentType?.startsWith('image/')) {
            const faviconTempPath = `${faviconPath}.tmp`;
            await writeFile(faviconTempPath, Buffer.from(await faviconResponse.arrayBuffer()));
            await rename(faviconTempPath, faviconPath);
            branding.faviconContentType = contentType;
        } else {
            await rm(faviconPath, { force: true });
        }
    } else {
        await rm(faviconPath, { force: true });
    }

    const brandingTempPath = `${brandingPath}.tmp`;
    await writeFile(brandingTempPath, `${JSON.stringify(branding)}\n`, { mode: 0o640 });
    await rename(brandingTempPath, brandingPath);
}

if (process.argv.includes('--capture-branding')) {
    await captureBranding();
    process.exit(0);
}

let branding = {};
try {
    branding = JSON.parse(readFileSync(brandingPath, 'utf8'));
} catch {}

const accentColor = validAccent(branding.accentColor);
const logoContentType = typeof branding.logoContentType === 'string' && branding.logoContentType.startsWith('image/')
    ? branding.logoContentType
    : 'application/octet-stream';
const faviconContentType = typeof branding.faviconContentType === 'string' && branding.faviconContentType.startsWith('image/')
    ? branding.faviconContentType
    : 'image/png';
const externalLogoUrl = typeof branding.externalLogoUrl === 'string' && /^https?:\/\//i.test(branding.externalLogoUrl)
    ? branding.externalLogoUrl
    : null;
const hasStoredLogo = existsSync(logoPath);
const hasDefaultLogo = existsSync(defaultLogoPath);
const hasStoredFavicon = existsSync(faviconPath);
const hasDefaultFavicon = existsSync(defaultFaviconPath);
const logoMarkup = hasStoredLogo || externalLogoUrl || hasDefaultLogo
    ? '<img class="logo" src="/maintenance-logo" alt="Node logo">'
    : '<div class="brand-fallback">Synapsis</div>';

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#090909">
  <link rel="icon" href="/maintenance-favicon">
  <title>Update in progress</title>
  <style>
    :root { --accent: ${accentColor}; color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; overflow: hidden; background: #090909; color: #f5f5f5; }
    body::before { content: ""; position: fixed; width: 34rem; height: 34rem; border-radius: 50%; background: color-mix(in srgb, var(--accent) 13%, transparent); filter: blur(110px); transform: translate(-38vw, -30vh); }
    main { width: min(90vw, 34rem); padding: 3rem; text-align: center; border: 1px solid #292929; border-radius: 1.75rem; background: rgba(18, 18, 18, .92); box-shadow: 0 2rem 7rem rgba(0, 0, 0, .5); }
    .logo { display: block; width: auto; max-width: min(18rem, 75%); height: auto; max-height: 6rem; margin: 0 auto 2rem; object-fit: contain; filter: drop-shadow(0 0 1.75rem color-mix(in srgb, var(--accent) 35%, transparent)); }
    .brand-fallback { margin: 0 auto 2rem; color: var(--accent); font-size: 1.5rem; font-weight: 800; letter-spacing: -.04em; }
    h1 { margin: 0; font-size: clamp(1.75rem, 6vw, 2.5rem); letter-spacing: -.045em; }
    p { margin: 1rem auto 0; max-width: 25rem; color: #a6a6a6; font-size: 1.05rem; line-height: 1.6; }
    .status { margin-top: 2rem; display: inline-flex; align-items: center; gap: .65rem; color: #d7d7d7; font-size: .9rem; }
    .dot { width: .6rem; height: .6rem; border-radius: 50%; background: var(--accent); animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .3; transform: scale(.75); } }
    @media (max-width: 520px) { main { padding: 2.25rem 1.5rem; } }
  </style>
</head>
<body>
  <main>
    ${logoMarkup}
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
    const requestPath = request.url?.split('?')[0];

    if (requestPath === '/maintenance-favicon') {
        const selectedFaviconPath = hasStoredFavicon ? faviconPath : defaultFaviconPath;
        if (hasStoredFavicon || hasDefaultFavicon) {
            const favicon = readFileSync(selectedFaviconPath);
            response.writeHead(200, {
                'Content-Type': hasStoredFavicon ? faviconContentType : 'image/png',
                'Content-Length': favicon.byteLength,
                'Cache-Control': 'no-store, max-age=0',
            });
            response.end(favicon);
            return;
        }
    }

    if (requestPath === '/maintenance-logo') {
        if (hasStoredLogo) {
            const logo = readFileSync(logoPath);
            response.writeHead(200, {
                'Content-Type': logoContentType,
                'Content-Length': logo.byteLength,
                'Cache-Control': 'no-store, max-age=0',
            });
            response.end(logo);
            return;
        }
        if (externalLogoUrl) {
            response.writeHead(302, { Location: externalLogoUrl, 'Cache-Control': 'no-store, max-age=0' });
            response.end();
            return;
        }
        if (hasDefaultLogo) {
            const logo = readFileSync(defaultLogoPath);
            response.writeHead(200, {
                'Content-Type': 'image/svg+xml',
                'Content-Length': logo.byteLength,
                'Cache-Control': 'no-store, max-age=0',
            });
            response.end(logo);
            return;
        }
    }

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
