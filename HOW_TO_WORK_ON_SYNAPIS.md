# Working on Synapsis

Synapsis uses an embedded Turso database and runs as a native Node.js process. Docker and a local PostgreSQL server are not part of the development or deployment workflow.

## Local loop

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

Before handing off a change:

```bash
npm run type-check
npm test
npm run build
```

When the schema changes, edit `src/db/schema.ts`, generate a migration with `npm run db:generate`, and verify it against a fresh database:

```bash
DATABASE_PATH=/tmp/synapsis-test.db npm run db:migrate
```

## VPS workflow

Production runs through `synapsis.service`, listening on `127.0.0.1:43821`. Reverse-proxy configuration belongs to the host operator.

```bash
sudo /opt/synapsis/deploy/update.sh
sudo systemctl status synapsis
sudo journalctl -u synapsis -f
```

The updater makes a timestamped database backup, pulls with `--ff-only`, installs dependencies, runs migrations, builds, and restarts the service.
