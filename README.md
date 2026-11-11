<p align="center">
  <img src="frontend/public/app-logo.png" alt="Hermit Edge" width="72" />
</p>

<h1 align="center">Sidecourt</h1>

<p align="center"><strong>Pickleball Control Room</strong></p>
<p align="center"><a href="https://sidecourt.hermitedge.com">Open Sidecourt</a></p>

Sidecourt connects the host's roster, waiting queue, courts and player screen to one session record. Hosts handle arrivals, breaks, team review, court assignment, match completion and corrections without maintaining a separate whiteboard.

Sidecourt began as a commissioned system for an Australian pickleball club and was later adapted for clients in the Philippines.

The public edition uses contextualized records and works alongside existing major booking platforms for Pickleball.

## What it does

### Run a session

- Configures 1–16 named courts, singles or doubles, venue time zone and house rotation rules.
- Previews prepared CSV rosters with reusable column mapping, stable member identities and explicitly reviewed profile corrections.
- Enrolls participants separately for each session; reusing the previous roster is an explicit choice.
- Tracks check-in, late arrivals, breaks, return and departure. Unknown ratings remain unknown.
- Keeps the roster and waiting order searchable and paginated without shortening the planner's input.
- Reviews teams across empty courts using queue order, known ratings and completed partner/opponent history.
- Requires approval for assignments and mixed-band exceptions. Assignment does not start play.
- Shares courts, staged groups and waiting positions through a temporary read-only player link.

### Review recorded activity

- Records completed matches and reasoned voids/corrections without losing historical identities.
- Opens saved, dated session reports with attendance, teams, match records and completed court time.
- Charts match starts and court time by session or venue-local day, and shows how completed games were distributed across checked-in players.
- Shows dated check-ins and game history with links to the underlying sessions.
- Exports attendance and match CSVs and prints complete selected reports.
- Keeps closed sessions read-only.

## Session flow

```text
Prepare roster → Check in → Wait / rest / return → Review rotation
→ Approve court assignments → Start → Complete or void
                                  ↓
                   Player screen and session records
```

## How it stays reliable

- The backend owns eligibility, court availability, timing, attendance and state transitions.
- Reviewed multi-court assignments commit together or reject without partial moves.
- Stale reviews cannot apply to a changed queue or occupied court.
- Duplicate completion retries do not create another completed game. After an uncertain write, refresh before retrying.
- Voids and corrections retain reasons and recalculate totals; active and voided games do not add completed court time.
- Matching is deterministic and bounded. There is no external model call or required AI key.

## Architecture

```text
Host browser / read-only player screen
                  ↓
        React + TypeScript
             Vercel
                  ↓
            Fastify API
             Railway
                  ↓
               SQLite
```

**Stack:** React, TypeScript, Vite, Zustand, dnd-kit, Motion, Three.js, Fastify, Zod and SQLite. Vercel and Railway are the deployment targets.

## Public edition

Each visitor receives a separate, temporary board with 12 courts and 96 fictional Australian-context members. The opening board includes active play, prepared groups, waiting players, breaks, arrivals, a populated current report and two closed archives. These are illustrative records, not client outcomes or measured capacity.

Use the host's generated Player screen link for the same board on another device. Opening the public app independently creates another visitor board. Expiry, restart or redeployment discards public boards.

## Implementation boundaries

| Area | Public edition |
| --- | --- |
| Roster intake | Permitted prepared CSV with mapped columns and reviewed updates. Not native Reclub/Pickleheads synchronization or a verified provider export adapter. Omitted rows do not withdraw players. |
| Existing platforms | Bookings, membership, payments and official ratings remain with their existing systems. No partnership is implied. |
| Matching | House rotation, not a universal tournament standard, official rating service or guarantee of zero repeats. |
| Daily reporting | Current venue time zone; distinct first check-ins and recorded matches by local start date. A match crossing midnight contributes its whole duration to its start date. Not utilization, revenue or savings analytics. |
| Player screen | Read-only, five-second polling. Waiting position is not an estimated start time. |
| Private deployment | One operator authority level, one backend instance and persistent SQLite storage with a verified backup/restore process. Not proven multi-venue or multi-operator capacity. |
| Evidence | This build demonstrates the current workflow, not every historical private feature or measured business outcome. |

## Run locally

Requires Node.js 22.12+ within the 22.x line and npm. Each application has its own lockfile and `.nvmrc`. If nvm is unavailable in a new terminal, first run `source "$HOME/.nvm/nvm.sh"`; omit `nvm use` if Node 22 is already active.

### Backend

```bash
cd backend
nvm use
npm ci
cp -n .env.example .env.local
PUBLIC_DEMO=true DEMO_SEED=false TRUST_PROXY_HOPS=0 npm run dev
```

The API runs at `http://localhost:3001`. The example environment is for local use; do not upload a filled environment file to production.

### Frontend

In another terminal:

```bash
cd frontend
nvm use
npm ci
cp -n .env.example .env.local
VITE_PUBLIC_DEMO=true VITE_API_URL= npm run dev
```

Open `http://localhost:5173`. Vite proxies local `/api` requests to the backend.

For private use, keep both public-mode flags false and configure a strong backend operator key. Never place a private key in frontend variables.

## Verification

```bash
cd backend
npm test -- --maxWorkers=2
npm run typecheck
npm run build

cd ../frontend
npm test
npm run typecheck
npm run lint
npm run build
```

The report update passed 461 frontend and 232 backend tests, both builds and frontend lint. The [verification record](docs/deployment.md#last-mile-verification--10-november-2026) covers the courtside layout and CSV import.

## Deployment

- **Railway:** root `/backend`, Railpack, Node 22, build `npm ci --no-audit --no-fund && npm run build`, start `npm start`, health check `/health`.
- **Vercel:** root `frontend`, Vite, Node 22.x, install `npm ci`, build `npm run build`, output `dist`.
- Public mode requires backend `PUBLIC_DEMO=true` and frontend `VITE_PUBLIC_DEMO=true`. Use one backend replica with Serverless disabled; no volume is needed for temporary public boards.
- Set Vercel's `VITE_API_URL` to the actual Railway HTTPS origin. Set Railway's `CORS_ORIGINS` to the exact frontend production origin.
- No Together API key is required. Do not upload local dependencies, client databases or filled environment files.

Follow the [manual dashboard deployment guide](docs/deployment.md#manual-dashboard-deployment). New Railway services require dashboard configuration; `backend/railway.toml` is a legacy reference, not automatic setup.

## Repository status

```text
frontend/   Browser application, public assets and Vercel configuration
backend/    API, database, rotation and backend tests
docs/       Operations, design, case study, deployment and GitHub handoff
README.md
.gitignore
```

The public source excludes credentials, private databases/exports, local deployment state, dependencies, generated builds, private delivery records and old Git history. It includes both dependency lockfiles and secret-free environment examples. The live deployment follows its own release cycle.

See [operations and data boundaries](docs/operations.md), [visual rules](docs/design.md) and [GitHub publication fields](docs/github.md).

## Project context

Club staff tracked players and courts on a whiteboard while bookings stayed in existing apps. Sidecourt gives the host one session record for arrivals, breaks, court assignments and corrections.

The commissioned package covered the configured workflow, agreed implementation, permitted roster migration, training and ongoing support. Exact acceptance, deployment and support evidence stays in the private engagement record. See the [engagement case study](docs/case-study.md).

Built by [Emman at Hermit Edge](https://hermitedge.com).

## Copyright

Copyright © 2026 Emman Ermitaño. All rights reserved.

Third-party product names and dependencies retain their respective owners' rights. Public source availability is not an open-source license or permission to redistribute private client material.
