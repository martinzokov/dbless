# dbless

A small JSON document service for Vercel apps, backed by one private Cloudflare R2 bucket. Each app and environment has its own key and object prefix. A Cloudflare Worker handles authentication and document operations; Vercel apps call it from server-side code.

## What it does

- Creates, reads, replaces, patches, lists, and logically deletes JSON documents.
- Keeps apps and environments separate within one bucket.
- Prevents stale writes with R2 conditional uploads and HTTP ETags.
- Supports read-only or read/write keys, optional collection restrictions, and key revocation.
- Limits each key to 300 requests per minute per Cloudflare location.
- Exports an app environment as newline-delimited JSON for backup.

This is suited to settings, small content collections, and apps that primarily address documents by ID. It has no field queries, multi-document transactions, or consistent snapshot exports.

## Set up

Prerequisites: Node.js 20+, a Cloudflare account, an R2 bucket, and an R2 API token with read/write access to that bucket. Keep the bucket private. The CLI uses the token to provision apps and keys; the Worker uses an R2 binding and never sees that token.

1. Run `npm install`.
2. Create a private R2 bucket called `dbless`, or change `bucket_name` in `wrangler.jsonc` to match your bucket.
3. Run `npx wrangler login` and `npx wrangler secret put CURSOR_SECRET`. Enter a random secret of at least 32 bytes. This signs list cursors.
4. Run `npm run deploy`. Save the Worker URL.
5. Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET` in your local shell. `.env.example` lists them. Do not commit credentials.
6. Run `npm run admin -- app create myapp`, then `npm run admin -- key create myapp production write`. Copy the API key printed once into a server-only Vercel environment variable.

For local Worker development, `npm run dev` uses local R2 storage. Set `CURSOR_SECRET` in `.dev.vars` (ignored by Git; add it to `.gitignore` if creating it) before using list endpoints. CLI provisioning uses the configured remote R2 bucket, so local Worker development requires local key records or a remote Worker.

The rate limit binding uses namespace ID `1001`. If your account already uses that ID for another rate limiter, change it in `wrangler.jsonc` before deploying. Cloudflare's rate limits are local to each location and are approximate, so they are an abuse guard rather than an exact billing quota. [Cloudflare rate limiting documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

## Server-side usage

Copy `sdk/index.ts` into your Vercel app, or build it with `npm run build:sdk` and import the resulting module.

```ts
import { createStore } from "./sdk/index";

interface Note { title: string; done: boolean }

const store = createStore({
  url: process.env.DBLESS_URL!,
  apiKey: process.env.DBLESS_API_KEY!,
});
const notes = store.collection<Note>("notes");

const created = await notes.create({ id: "first", data: { title: "Try dbless", done: false } });
const current = await notes.get("first");
await notes.patch("first", { done: true }, { ifMatch: current.etag });
const page = await notes.list({ limit: 50 });
await notes.delete("first", { ifMatch: (await notes.get("first")).etag });
```

Keep the API key in server-side code. Your app must check its own users' permissions and ownership before calling dbless. An app key grants access to its entire configured namespace.

## HTTP API

All requests except `GET /health` use `Authorization: Bearer <api-key>`. Write bodies are JSON objects with `Content-Type: application/json`. The app and environment come from the key, never from the URL.

| Method | Path | Result |
| --- | --- | --- |
| `POST` | `/v1/collections/:collection/documents?id=:optionalId` | Create; `201`, `409` if ID exists |
| `GET` | `/v1/collections/:collection/documents/:id` | Read; `200` with ETag, or `404` |
| `PUT` | `/v1/collections/:collection/documents/:id` | Replace data; requires `If-Match` |
| `PATCH` | `/v1/collections/:collection/documents/:id` | JSON Merge Patch on data; requires `If-Match` |
| `DELETE` | `/v1/collections/:collection/documents/:id` | Logical delete; requires `If-Match` |
| `GET` | `/v1/collections/:collection/documents?limit=50&cursor=…` | List summaries and next cursor |

Listing also accepts `prefix` to match the beginning of document IDs and `include=data` to include document bodies. Limits are 100 summaries or 20 documents with data per page. Deleted documents are omitted. A page can contain fewer documents than requested, including zero, while still returning a cursor. Continue until `cursor` is `null`.

An ETag is the version token for a single document. If another writer changes it, the conditional write fails with `412`; reread and decide how to reconcile. Missing `If-Match` returns `428`. The service never automatically overwrites a newer version. Patch follows JSON Merge Patch rules: `null` removes a field; arrays replace arrays.

The document body is `{ id, revision, createdAt, updatedAt, deleted, data }`. The input size limit is 256 KiB including the stored envelope. Names use lowercase letters, digits, `_`, and `-`; document IDs can also use uppercase letters. Logical deletes leave a tombstone, and IDs cannot be reused.

## Administration and backups

```sh
npm run admin -- app create another-app
npm run admin -- key create another-app development read
npm run admin -- key create another-app production write notes,settings
npm run admin -- key revoke <key-id>
npm run admin -- app export another-app production > backup.ndjson
```

Export includes tombstones. It reads live objects, so concurrent writes can make the export inconsistent. Pause writes when you need a consistent backup. Store backups somewhere separate from the primary R2 bucket. Key records are never included in app exports.

Rotate a key by issuing a second key, updating the Vercel environment variable, deploying the app, and revoking the old key. A revoked key stops working on the next request.

## Limits and security

R2 stores documents at `data/v1/<app>/<environment>/<collection>/<id>.json`. Credential records live under `system/v1/`. The Worker derives every data path from the authenticated key and validated names. Keys are stored as SHA-256 hashes of 32 random bytes; the plaintext secret appears only when the CLI creates it.

Reads and writes are strongly consistent for an individual R2 object. Lists spanning multiple requests are not snapshots. Conditional writes make updates to one document safe from lost updates. A delete writes a tombstone conditionally because R2's Worker delete API does not accept a write condition. [R2 Worker API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

The service validates JSON object input and applies size limits. It does not validate application schemas. The Worker logs internal failures without logging request bodies or API keys. Use Cloudflare Workers logs for operation monitoring and back up app data regularly.

Run `npm run typecheck`, `npm test`, and `npm run build:sdk` before deployment.
