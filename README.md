# Expense Tracker

A small full-stack expense tracker built for a technical assessment. The app uses a Node.js/Express REST API, SQLite persistence, and a single-page HTML/vanilla JavaScript frontend.

## Requirements

- Node.js 18 or newer
- npm

## Run Locally

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

The API and frontend are served by the same Express server. The SQLite database is created automatically as `expenses.sqlite`.

## Deploy on Render

Use a Render Web Service with these settings:

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`

Do not commit `node_modules` or SQLite database files. Render runs `npm install` on Linux during each deploy, which installs the correct Linux build of `sqlite3`. Committing Windows-built `node_modules` can cause errors such as `invalid ELF header sqlite3`.

Render provides `process.env.PORT`; the server uses that value automatically and falls back to `3000` for local development.

## API

### POST /expenses

Creates an expense.

```json
{
  "amount": 12.5,
  "category": "Food",
  "description": "Lunch",
  "date": "2026-05-01"
}
```

Validation rules:

- `amount` is required and must be greater than 0
- `category` is required
- `description` is optional
- `date` is required and must be `YYYY-MM-DD`

Clients can send an `Idempotency-Key` header. If the same key and same request body are sent again, the API returns the original expense instead of inserting a duplicate. If the same key is reused with different data, the API returns `409 Conflict`.

### GET /expenses

Returns expenses.

Supported query params:

- `category=Food`
- `sort=date_desc`

Example:

```text
GET /expenses?category=Food&sort=date_desc
```

## Design Decisions

- SQLite is used for simple local persistence with no external service dependency.
- Express serves both the API and `index.html`, so the app runs from one command.
- SQL statements are parameterized to avoid injection.
- Idempotency is stored in a separate table instead of overloading the `expenses` schema.
- The frontend disables the submit button during requests and also keeps an `isSubmitting` guard for slow responses or repeated clicks.
- The frontend fetches expenses newest-first and performs category filtering in the browser for a simple, responsive UI.

## Trade-offs Due to Time

- The project is intentionally kept in a few files for easy assessment review.
- There is no authentication or multi-user support.
- There is no automated test suite, though the backend is structured into small functions that would be straightforward to test.
- The UI is minimal and functional rather than heavily designed.

## What Is Not Implemented

- Edit and delete expense flows
- Pagination for very large datasets
- User accounts or authorization
- Currency selection
- Production logging/metrics
- Database migrations beyond initial table creation
