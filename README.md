# AI Estimator

This project demonstrates a serverless-friendly Express app that accepts construction estimation inputs (CSV & PDFs), uses a GenAI model to produce an estimate, and stores inputs/outputs in cloud object storage (S3 or GCS).

Features added:
- Direct presigned PUT uploads for client-side uploads (`/api/presign-upload`).
- `/api/estimate` supports either client-supplied object keys (recommended) or multipart file uploads (falls back to multer).
- Supports `S3` and `GCS` via `STORAGE_PROVIDER` or by setting `S3_BUCKET`/`GCS_BUCKET`.
- Generated CSV outputs are uploaded to storage and a presigned GET URL is returned.
- Incoming multipart uploads are persisted to storage for auditing and debugging.
- Audit log: `logs/input-uploads.log` contains JSONL entries for persisted inputs and key usage.

Environment variables (required)
- For S3:
  - `STORAGE_PROVIDER=s3` (optional)
  - `S3_BUCKET`
  - `AWS_REGION`
  - `AWS_ACCESS_KEY_ID`
  - `AWS_SECRET_ACCESS_KEY`
- For GCS:
  - `STORAGE_PROVIDER=gcs` (optional)
  - `GCS_BUCKET`
  - Ensure Google application credentials are available (e.g., set `GOOGLE_APPLICATION_CREDENTIALS` to a service account JSON file path in local dev, or set credentials in your deployment platform).
- Audit DB provider:
  - `AUDIT_DB_PROVIDER=postgres` or `firestore` or `sqlite` (default)
  - `DATABASE_URL` for Postgres
  - `FIRESTORE_PROJECT_ID` or standard Firestore credentials environment for Firestore
- Common:
  - `GEMINI_API_KEY` (Google GenAI key used in this demo)
  - Optional: `SIGNED_URL_EXPIRY_UPLOAD` (seconds, default 900)
  - Optional: `SIGNED_URL_EXPIRY` (seconds, default 604800)

Local dev
1. Install dependencies:
```bash
npm install
```
2. Start locally (dev only):
```bash
npm run start
```
3. Start locally with mock GenAI output (no real API needed):
```bash
npm run start:mock
```
4. Run the smoke test:
```bash
npm run smoke-test
```
5. Open the demo in your browser:
```
http://localhost:3000/presign-demo-react.html
```

Classic fallback demo:
```
http://localhost:3000/presign-demo.html
```

Client flow (presign demo)
1. Client requests presigned PUT URL from `/api/presign-upload` with `{ filename, contentType }`.
2. Client PUTs the file directly to that URL.
3. Client calls `/api/estimate` with JSON body `{ costCodeKey, sampleEstimateKey, drawingKeys, projectNotes }` to trigger processing.
4. Server fetches inputs from storage, runs the model, uploads result CSV to storage, and returns `{ csvDownloadPath, inputKeys, estimate, ... }`.

Notes
- Keep lifecycle rules on the bucket to avoid indefinite storage growth.
- Use least-privilege IAM roles for production.
- For large or CPU-bound processing, consider background workers instead of a serverless function.

If you want, I can:
- Add a small client-side example page that persists response history to localStorage.
- Add structured logging or push audit entries into a DB (Postgres/FireStore) instead of JSONL.
- Run a local smoke test (requires valid credentials).
