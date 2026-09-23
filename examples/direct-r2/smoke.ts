import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createStore, StoreError } from "../../src/index";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const store = createStore({
  accountId: required("R2_ACCOUNT_ID"),
  bucket: required("R2_BUCKET"),
  accessKeyId: required("R2_ACCESS_KEY_ID"),
  secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  app: "dbless-direct-test",
  environment: "local",
});

const notes = store.collection<{ title: string; done: boolean }>("smoke");
const id = `test_${randomUUID()}`;
const created = await notes.create({ id, data: { title: "Direct R2 smoke test", done: false } });
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
console.log(`PASS direct R2 create/read/patch/list/delete for ${id}`);
