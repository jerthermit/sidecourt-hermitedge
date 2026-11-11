# Deployment and recovery

## Manual dashboard deployment

Use the same deployment repository for Vercel and Railway. The public GitHub showcase can be a separate repository.

### Railway

| Setting | Value |
| --- | --- |
| Root directory | `/backend` |
| Builder | Railpack, Node 22 |
| Build | `npm ci --no-audit --no-fund && npm run build` |
| Start | `npm start` |
| Health check | `/health`, 30-second timeout |
| Replicas | 1 |
| Serverless | Disabled |
| Restart | On Failure, up to 5 retries |
| Volume | None for the public edition |

Set these service variables:

```dotenv
HOST=0.0.0.0
RAILPACK_NODE_VERSION=22
PUBLIC_DEMO=true
DEMO_SEED=false
TRUST_PROXY_HOPS=1
VISITOR_TTL_MINUTES=120
MAX_VISITORS=30
```

Generate a public HTTPS domain. Its target port must match the `PORT` supplied by Railway. Verify `/health` and copy the API origin without a path or trailing slash. Use the dashboard settings for new services. The checked-in `railway.toml` records the equivalent legacy settings. [Railway build configuration](https://docs.railway.com/builds/build-configuration) · [Railway public networking](https://docs.railway.com/networking/public-networking)

### Vercel

| Setting | Value |
| --- | --- |
| Root directory | `frontend` |
| Framework | Vite |
| Node.js | 22.x |
| Install | `npm ci` |
| Build | `npm run build` |
| Output | `dist` |

Set the Production variables, replacing the API placeholder with the Railway origin:

```dotenv
VITE_API_URL=https://your-api.up.railway.app
VITE_PUBLIC_DEMO=true
```

Keep operator credentials in backend variables. A change to a Vite variable requires a new frontend build. [Vercel environment variables](https://vercel.com/docs/environment-variables/managing-environment-variables)

### Pair the origins

Set Railway's `CORS_ORIGINS` to the exact HTTPS frontend origin and redeploy the API. Use comma-separated origins if both a custom and a Vercel domain should work. Origins have no path or trailing slash. For a deployment-specific CSP, replace the generic `https:` in `frontend/vercel.json` under `connect-src` with the API origin and retain `'self'`.

Use only fictional records in public mode. Each board lives in memory and expires after its configured lifetime. Restarting the backend clears all public boards and read-only links. `MAX_VISITORS` limits boards.

## Private deployment

Set both public-mode flags to `false`, keep `DEMO_SEED=false` and set a strong backend `OPERATOR_ACCESS_KEY`. The key requires 16–512 characters and no line breaks. On Railway, attach a persistent volume. With `DATABASE_PATH` unset, the API stores SQLite at `RAILWAY_VOLUME_MOUNT_PATH/pickleball.db`. An explicit database path must be inside that volume. Test restart and restore before using club records.

The API runs migrations at startup. Back up before upgrading a private database, and install dependencies for the deployment runtime and operating system. [Railway volumes](https://docs.railway.com/volumes)

## Release check

1. Start two public boards in separate browser sessions. A host action or reset must affect only its own board.
2. Import a roster CSV with custom headers, check in players and record a break and return. Reimport the same rows and confirm the roster has no duplicates.
3. Duplicate the host tab and verify both show the same board. Review an assignment in one tab, change the queue in the other and try the stale review. Refresh and approve a new one. Start and complete a match, then void an accidental start and verify it does not count.
4. Open the **Player screen** link on another device. Check court and queue updates, and confirm the screen exposes only read-only controls.
5. In **Reports**, compare a saved session and a venue-local day with the recorded matches. Check CSV exports and print all records, including rows beyond the current screen page.
6. For a private deployment, restart and confirm the database persists. Rehearse restoration on a separate service.

## Recovery

- **Uncertain write** — Refresh the board before retrying. The server may have committed the change.
- **Stale assignment or import** — Review the current state and create a new preview. A profile update requires explicit approval.
- **Public expiry** — Open a fresh board and create a new player-screen link.
- **Private migration failure** — Stop writes and preserve the database and its WAL/SHM files. Restore a consistent backup to a separate location first. Roll back the application and database together.
- **Operator key exposure** — Rotate the backend key, restart the API, clear old browser credentials and review access logs.

See the [operations guide](operations.md) for permissions, report definitions and handover.
