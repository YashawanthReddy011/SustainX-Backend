# SustainX Backend

TypeScript Express API for the SustainX frontend.

## Run

```bash
npm install
npm run dev
```

The API runs on `http://localhost:5000` by default.

## Routes

- `GET /api/health`
- `POST /api/auth/login` with `{ "email": "student@example.com" }`
- `GET /api/sdgs`
- `GET /api/sdgs/:id`
