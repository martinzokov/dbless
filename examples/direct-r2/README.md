# Direct R2 example

This script imports `dbless` and accesses a private Cloudflare R2 bucket directly.

From the repository root, create an ignored `.env` file with `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. Use a Cloudflare R2 token with Object Read & Write permission for the chosen bucket.

```sh
npm install
npm run smoke:r2
```

The script creates, reads, patches, lists, and logically deletes a document under `data/v1/dbless-direct-test/local/smoke/`. A tombstone remains after deletion.
