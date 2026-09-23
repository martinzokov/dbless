# dbless

A small JSON document API for apps hosted on Vercel. The dbless service is itself one Vercel project and stores documents in a private Cloudflare R2 bucket. You can reuse the same bucket for many apps.

Each consuming app needs only:

```text
DBLESS_URL=https://your-dbless-project.vercel.app
DBLESS_API_KEY=dbj_live_...
```

The central dbless Vercel project holds the R2 account ID, bucket name, and R2 access key pair. Consuming apps never receive R2 credentials. R2's S3 API requires an access key ID and secret, so a shared API is what reduces each app's configuration to one URL and one key. [R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/)

## Features

- Create, read, replace, patch, list, and logically delete JSON documents.
- Separate app and environment namespaces in one R2 bucket.
- Read-only or read/write keys, optionally restricted to collections.
- Conditional writes with ETags to reject stale updates.
- An admin CLI for app registration, key rotation, export, and import.
- A small TypeScript client for server-side Vercel code.

This is suited to settings, small content collections, and apps that primarily address documents by ID. It has no field queries, multi-document transactions, or consistent snapshot exports.

## Set up the central service

Prerequisites: Node.js 24, a Vercel account, a private Cloudflare R2 bucket, and an R2 API token with read/write access to that bucket.

1. Run `npm install`.
2. Create a private R2 bucket, such as `dbless`.
3. Create a Vercel project from this repository. Vercel serves `api/handler.ts` as a Node.js Function; `vercel.json` maps the public `/v1/...` routes to it. [Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js), [rewrites](https://vercel.com/docs/routing/rewrites/)
4. Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and `CURSOR_SECRET` as environment variables on that central project. `CURSOR_SECRET` must be at least 32 random bytes. `.env.example` lists the variables. `MAX_DOCUMENT_BYTES` is optional and defaults to 262144.
5. Deploy the central project and save its URL. `GET /health` should respond with `{"ok":true}`.
6. Set the same R2 variables in your local shell to run the admin CLI. Run `npm run admin -- app create myapp`, then `npm run admin -- key create myapp production write`. The key is shown once.
7. Set `DBLESS_URL` and `DBLESS_API_KEY` in the consuming app's server-only Vercel environment variables.

The R2 credentials and cursor secret belong only to the central project and administrator. The consuming apps do not need the bucket ID, account ID, or R2 endpoint because the shared API already knows them.

## Use from an app

Copy `sdk/index.ts` into your app, or build it with `npm run build:sdk` and import the resulting module.

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

Listing accepts `prefix` for document IDs and `include=data` to include bodies. Limits are 100 summaries or 20 documents with data per page. The S3 list operation does not return document metadata, so dbless reads each listed document to build the response. A page can contain fewer documents than requested, including zero, while still returning a cursor. Continue until `cursor` is `null`.

An ETag is the version token for one document. If another writer changes it, the conditional write fails with `412`; reread and reconcile. Missing `If-Match` returns `428`. Patch follows JSON Merge Patch rules: `null` removes a field; arrays replace arrays.

The document body is `{ id, revision, createdAt, updatedAt, deleted, data }`. The size limit is 256 KiB including the envelope. Names use lowercase letters, digits, `_`, and `-`; IDs can also use uppercase letters. Deletes leave tombstones, and IDs cannot be reused.

## Administration and backups

```sh
npm run admin -- app create another-app
npm run admin -- key create another-app development read
npm run admin -- key create another-app production write notes,settings
npm run admin -- key revoke <key-id>
npm run admin -- app export another-app production > backup.ndjson
# Restore into an empty another-app/production namespace:
npm run admin -- app import another-app production backup.ndjson
```

Export includes tombstones. It reads live objects, so concurrent writes can make the export inconsistent. Pause writes for a consistent backup and store backups outside the primary bucket. Import validates the app/environment path and uses conditional creation; it stops at the first existing object. A failed import may have partially succeeded. To restore into a different namespace, change the object key prefixes in the NDJSON file first. Schedule the export command from your own backup runner if you need automatic backups.

Rotate a key by issuing a second key, updating the consuming app's environment variable, deploying it, and revoking the old key. A revoked key stops working on the next request.

## Limits and security

R2 stores documents at `data/v1/<app>/<environment>/<collection>/<id>.json`. Credential records live under `system/v1/`. The API derives every data path from the authenticated key and validated names. Keys are stored as SHA-256 hashes of 32 random bytes; the plaintext appears only when the CLI creates it.

Reads and writes are strongly consistent for an individual R2 object. Lists spanning multiple requests are not snapshots. Conditional S3 `PutObject` calls protect creates, updates, and tombstone deletes from lost writes. [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)

The API validates JSON object input and applies size limits. It does not validate application schemas. It logs internal failures without logging request bodies or API keys. Configure request rate limiting in the central Vercel project's Firewall if the public endpoint needs an abuse guard.

Run `npm run typecheck`, `npm test`, and `npm run build:sdk` before deployment.

## Examples

The [local R2 example](examples/local/README.md) starts dbless on `127.0.0.1` and tests it against a real bucket. It does not use Vercel.

### Local R2 smoke test

To test the real bucket without deploying to Vercel, create a bucket-scoped R2 token with Object Read & Write permission. Put its access key ID and secret in an ignored `.env` file with the R2 account ID, bucket name, and a random `CURSOR_SECRET` of at least 32 bytes. Set `DBLESS_URL=http://127.0.0.1:8787`.

```sh
npm run admin:local -- app create dbless-test
npm run admin:local -- key create dbless-test local write
# Put the generated dbj_live_... key in DBLESS_API_KEY in .env.
npm run dev:local
# In another terminal:
npm run smoke:local
```

The local server listens only on `127.0.0.1`. The smoke test creates one document, reads it, patches it, lists it, then logically deletes it. The tombstone remains in the test bucket. `.env` is ignored by Git.
