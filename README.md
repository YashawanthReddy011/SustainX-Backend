# SustainX Backend

TypeScript Express API for the SustainX frontend.

## Run

```bash
npm install
npm run dev
```

On Windows PowerShell, use `npm.cmd` in these commands if the local script execution policy blocks `npm.ps1`.

Start the API, public frontend, and admin console in separate terminals:

```powershell
cd backend; npm.cmd run dev
cd frontend; npm.cmd run dev
cd admin; npm.cmd run dev
```

The public app runs on port 3000 and the admin console on port 3001. Seed records are written to the configured MongoDB when you explicitly run `npm.cmd run seed` from `backend`.

Set `DATABASE_URL` in `backend/.env` to your MongoDB connection string first. The API connects to MongoDB at startup and runs on `http://localhost:5000` by default.

Run `npm run seed` after configuring the database. The idempotent seed stores the 17 SDGs, sample challenges/projects/community reports, and these local demo accounts:

- `student@sustainx.local` (student)
- `community@sustainx.local` (community)
- `admin@sustainx.local` (administrator)

The demo sign-in flow uses email only and is intended for local development. Replace it with your production identity provider before deploying.

To load the 17 Sustainable Development Goals into the `Sdg` collection, run:

```bash
npm run seed
```

## Routes

- `GET /api/health`
- `POST /api/auth/login` with `{ "email": "student@example.com" }`
- `GET /api/sdgs`
- `GET /api/sdgs/:id`
- `PATCH /api/sdgs/:id` (administrator)
- `GET /api/summary`
- `GET /api/dashboard/me` (signed in)
- `GET /api/challenges`, `POST /api/challenges/:id/join`
- `GET /api/projects`, `POST /api/projects`, `POST /api/projects/:id/join`
- `GET /api/reports`, `POST /api/reports`, `PATCH /api/reports/:id/status` (administrator)
- `GET /api/activities/mine`, `POST /api/activities`
- `GET /api/admin/overview`, `/api/admin/activities`, `/api/admin/users` (administrator)
- `PATCH /api/admin/activities/:id/review`, `POST /api/admin/users` (administrator)
- `GET /api/certificates/mine`, `GET /api/certificates/verify/:id`
