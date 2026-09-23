# Local R2 example

This example runs the dbless API on `127.0.0.1:8787` and uses the SDK to exercise a real R2 bucket. The API stays on your machine; no Vercel project is involved.

From the repository root, copy `.env.example` to `.env` and fill in a bucket-scoped R2 access key pair, account ID, bucket name, and a random `CURSOR_SECRET` of at least 32 bytes. `.env` is ignored by Git.

Register a test app and create its key:

```sh
npm run admin:local -- app create dbless-test
npm run admin:local -- key create dbless-test local write
```

Put the generated `dbj_live_...` key in `DBLESS_API_KEY` in `.env`. Then run the server and smoke test in separate terminals:

```sh
npm run dev:local
npm run smoke:local
```

The smoke test creates a document, reads it, patches it, lists it with data, and logically deletes it. The delete leaves a tombstone in R2, as the production API does.
