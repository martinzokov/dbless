import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createStore, StoreError } from "../sdk/index";

const url = process.env.DBLESS_URL ?? "http://127.0.0.1:8787";
const apiKey = process.env.DBLESS_API_KEY;
if (!apiKey) throw new Error("DBLESS_API_KEY is required");

const store = createStore({ url, apiKey });
const notes = store.collection<{ title: string; done: boolean }>("smoke");
const id = `test_${randomUUID()}`;

const created = await notes.create({ id, data: { title: "Local R2 smoke test", done: false } });
console.log(`Created test document ${id}`);
assert.equal(created.id, id);
const read = await notes.get(id);
assert.equal(read.data.done, false);
const updated = await notes.patch(id, { done: true }, { ifMatch: read.etag });
assert.equal(updated.data.done, true);
const page = await notes.list({ prefix: id, includeData: true });
assert.equal(page.documents[0]?.data?.done, true);
await notes.delete(id, { ifMatch: updated.etag });
await assert.rejects(() => notes.get(id), (cause: unknown) => cause instanceof StoreError && cause.status === 404);
console.log(`PASS create/read/patch/list/delete for ${id}`);
