# How To Work On Synapsis
This is the practical workflow for developing Synapsis without turning every bugfix into a full Docker release.

## Basic Rule
Use three different loops for three different jobs:
1. `npm run dev` for normal feature work and bugfixes
2. local Docker source builds when you need container parity
3. GHCR publish only when you actually want the server to update

Do **not** rebuild and push a Docker image for every tiny fix. Batch fixes together, verify them locally, then publish when the server needs the new version.

## 1. Normal Local Development
Use this for most day-to-day work.

```bash
npm install
cp .env.example .env
npm run db:push
npm run dev
```

Useful verification commands:

```bash
npm run type-check
npm run build
npm test
```

Use this loop when:
- changing UI
- fixing API logic
- working on auth, feed logic, posting, bots, or settings
- you do not specifically need to test the Docker runtime

## 2. Local Docker Parity Test
Use this when you want to know whether the app still works inside the actual container setup. This compose file builds from your local source tree:

```bash
cd docker
cp .env.example .env
docker compose up --build
```

That uses [docker/docker-compose.yml](/Users/christopher/Dev/Synapsis/Synapsis/docker/docker-compose.yml) and [docker/Dockerfile](/Users/christopher/Dev/Synapsis/Synapsis/docker/Dockerfile).

Use this loop when:
- Docker-specific startup behavior matters
- you changed the Dockerfile or entrypoint
- you changed env handling, healthchecks, migrations, ports, or install flow

## 3. Production Image Publish
Use this only when you want the server or end users to pull a new image. The production install uses [docker-compose.yml](/Users/christopher/Dev/Synapsis/Synapsis/docker-compose.yml) and `ghcr.io/gnosyslabs/synapsis:latest`.

### First-time GHCR auth on this machine
```bash
gh auth refresh -h github.com -s read:packages -s write:packages
gh auth token | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

### Publish the image
Push code first:

```bash
git push origin main
```

Then build and push the multi-arch image:

```bash
docker buildx build \
  --builder colima \
  --platform linux/amd64,linux/arm64 \
  -f docker/Dockerfile \
  -t ghcr.io/gnosyslabs/synapsis:latest \
  -t ghcr.io/gnosyslabs/synapsis:$(git rev-parse --short HEAD) \
  --push \
  .
```

That publishes:
- `ghcr.io/gnosyslabs/synapsis:latest`
- `ghcr.io/gnosyslabs/synapsis:<short-sha>`

If you are not on a Mac/Colima setup, swap `--builder colima` for whatever local buildx builder you use.

## 4. Update The Server
Once a new image is published, update the server with:

```bash
cd /opt/synapsis
docker compose pull
docker compose up -d
```

Useful checks:

```bash
docker compose ps
docker compose logs -f app
docker compose images
```

## 5. Which Compose File Is Which
There are two main Docker compose paths in this repo.

### Local source-build compose
File: [docker/docker-compose.yml](/Users/christopher/Dev/Synapsis/Synapsis/docker/docker-compose.yml)

Purpose:
- local Docker testing
- builds from your current working tree
- no GHCR push required

### Production install compose
File: [docker-compose.yml](/Users/christopher/Dev/Synapsis/Synapsis/docker-compose.yml)

Purpose:
- end-user install
- server deployment
- uses `ghcr.io/gnosyslabs/synapsis:latest`

Do not confuse them.

## 6. Recommended Workflow
This is the default path that makes the most sense for Synapsis:
1. Make code changes locally
2. Run `npm run type-check`
3. Run `npm run build`
4. If Docker behavior matters, run `cd docker && docker compose up --build`
5. Keep stacking fixes until the server actually needs them
6. Commit and push
7. Build and push the GHCR image
8. Pull and restart on the server

## 7. When To Publish A New Docker Image
Publish when:
- you want the fix on the real server
- you changed install/runtime/container behavior
- you finished a coherent batch of fixes

Do not publish just because:
- one small UI bug was fixed locally
- one small API bug was fixed and not needed on the server yet

## 8. Current Install Reality
For clean servers, the normal install path is:

```bash
curl -fsSL https://synapsis.social/install.sh | bash
```

For servers that already run nginx or another reverse proxy on `80/443`, use:

```bash
curl -fsSL https://synapsis.social/install.sh | PROXY=none bash
```

In `PROXY=none` mode, Synapsis binds to `127.0.0.1:${PORT}` and your existing reverse proxy should point there.
