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

Authentication is configured in the same file. Set a private `DEMO_ACCOUNT_PASSWORD` with at least 12 characters before seeding. `npm run seed` uses it for the three local demo accounts and upgrades older demo records that do not have password hashes yet. Do not use demo accounts in production.

New public registrations are student accounts and remain locked until their email is verified. In development, verification and reset links are printed in the backend terminal. In production, configure `AUTH_EMAIL_API_KEY` and `AUTH_EMAIL_FROM` for the Resend email API, and set `JWT_SECRET` to a random value of at least 32 characters. The frontend origin for verification and reset links is `CLIENT_URL`.

Passwords are hashed with bcrypt. Access tokens expire after two hours, logout revokes the current token, password resets revoke all existing sessions, and protected API requests load the user's current role and status from MongoDB. Login and recovery routes have per-process IP rate limits; use a shared rate-limit store if deploying multiple API instances.

Run `npm run seed` after configuring the database. The idempotent seed stores the 17 SDGs, sample challenges/projects/community reports, and these local demo accounts:

- `student@sustainx.local` (student)
- `community@sustainx.local` (community)
- `admin@sustainx.local` (administrator)

To load the 17 Sustainable Development Goals into the `Sdg` collection, run:

```bash
npm run seed
```

## Routes

### Versioned API

The public frontend and admin console use `http://localhost:5000/api/v1`. Existing `/api/*` routes remain available for compatibility. Versioned JSON responses use `{ "success": true, "data": ... }`; collection responses also include `meta` with `page`, `limit`, `total`, and `totalPages`. Use `page` and `limit` query parameters (`limit` is 1–100). Errors use `{ "success": false, "error": "...", "details"?: ... }`.

- Authentication: `/auth/register`, `/auth/login`, `/auth/me`, `/auth/logout`
- Home: `/home/stats`, `/home/recent-activities`
- SDGs: `/sdgs`, `/sdgs/:id`, `/sdgs/:id/progress`
- Challenges: `/challenges`, `/challenges/:id`, `/challenges/:id/join`
- Submissions: `/submissions`, `/submissions/:id`
- Projects: `/projects`, `/projects/:id`, `/projects/:id/members`
- Community reports: `/community/reports`, `/community/reports/:id`
- EcoGuard: `/ecoguard/activities`, `/ecoguard/activities/summary`, `/ecoguard/submissions`
- Dashboards: `/dashboard/student`, `/dashboard/community`, `/dashboard/admin`
- Chat: `/chat/conversations`, `/chat/messages` (history by `conversationId`; POST to send)
- Notifications: `/notifications`, `/notifications/read`
- Certificates: `/certificates`, `/certificates/:id`
- Analytics: `/analytics/impact`, `/analytics/sdgs`

Collection routes accept pagination and relevant filters such as `status`, `sdgId`, `category`, `location`, `search`, and EcoGuard `type`. Role-specific dashboard routes require a signed-in account with the matching backend role. Do not send a role from the client as authorization.

- `GET /api/health`
- `POST /api/auth/register` with `{ "name": "...", "email": "...", "password": "..." }`
- `POST /api/auth/login` with `{ "email": "...", "password": "..." }`
- `POST /api/auth/verify-email`, `/api/auth/resend-verification`
- `POST /api/auth/forgot-password`, `/api/auth/reset-password`
- `POST /api/auth/logout` and `GET /api/auth/me` (signed in)
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

### Community chat

The community chat is a Socket.IO feature served by the same API process. Authenticated users can open the global community room, direct and group conversations, and project or challenge discussions. Project and challenge membership is checked against the current record on each history read, room join, read receipt, and send.

- `GET /api/chat/conversations` (signed in)
- `POST /api/chat/direct`, `POST /api/chat/groups`
- `POST /api/chat/community/open`, `POST /api/chat/projects/:projectId/open`, `POST /api/chat/challenges/:challengeId/open`
- `GET /api/chat/conversations/:id/messages` with `limit` and `cursor` pagination; `GET .../messages/search?q=...`
- `POST /api/chat/conversations/:id/read`
- `GET /api/chat/users?q=...`, `GET /api/chat/blocks`, `POST|DELETE /api/chat/users/:userId/block`
- `POST /api/chat/messages/:messageId/report`, `GET /api/chat/notifications/unread-count`
- `GET /api/chat/admin/reports`, `PATCH /api/chat/admin/reports/:reportId` (administrator)

The Socket.IO handshake uses the same signed bearer token as the REST API. A connection gets a user room after token and account validation; it can enter a conversation room only after membership checks. Sending requires current membership and a joined room, and is limited to 30 messages per user per minute per API process. Message history is paginated and membership is rechecked before each read or send. Notifications are stored with each message and marked read with the conversation.

MongoDB stores `Conversation`, `ConversationMember`, `Message`, `Notification`, `UserBlock`, and `MessageReport` records with indexes created at API startup. Image attachments must first be uploaded through authenticated `POST /api/media` (JPEG, PNG, WebP, or GIF, up to 5 MB); chat accepts only URLs present in the sender's media records. Configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` in the ignored `backend/.env` file for uploads; keep the API secret server-side. Administrators can dismiss reports or remove a reported message from future history and search results.
