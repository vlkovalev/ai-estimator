# Changelog

## [Unreleased]

- Added production audit logging support for Postgres and Firestore via `AUDIT_DB_PROVIDER`.
- Added a React-based demo UI at `public/presign-demo-react.html` with nicer layout, status tracking, and history.
- Added cross-platform `npm run start:mock` script for local testing without GenAI credentials.
- Added full audit database support while preserving SQLite fallback.
- Added `package.json` dependencies for Postgres (`pg`) and Firestore (`@google-cloud/firestore`).
- Improved README documentation for storage provider, audit DB provider, and React demo usage.
