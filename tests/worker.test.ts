import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import worker from "../worker/index";

const tokenA = `dbj_live_${"a".repeat(24)}_${"x".repeat(43)}`;
const tokenB = `dbj_live_${"b".repeat(24)}_${"y".repeat(43)}`;

function bucket() {
  const objects = new Map<string, { body: string; etag: string; metadata: Record<string, string> }>();
  let sequence = 0;
  const wrap = (key: string, item: NonNullable<ReturnType<typeof objects.get>>) => ({
    key, etag: item.etag, httpEtag: `"${item.etag}"`, customMetadata: item.metadata,
    json: async () => JSON.parse(item.body) as unknown,
  });
  return {
    objects,
    async get(key: string) {
      const item = objects.get(key);
      return item ? wrap(key, item) : null;
    },
    async put(key: string, value: string, options: { onlyIf?: Headers; customMetadata?: Record<string, string> } = {}) {
      const current = objects.get(key);
      if (options.onlyIf?.get("if-none-match") === "*" && current) return null;
      const match = options.onlyIf?.get("if-match");
      if (match && `"${current?.etag}"` !== match) return null;
      const item = { body: value, etag: String(++sequence), metadata: options.customMetadata ?? {} };
      objects.set(key, item);
      return wrap(key, item);
    },
    async list(options: { prefix: string; cursor?: string; limit: number }) {
      const matching = [...objects.entries()].filter(([key]) => key.startsWith(options.prefix)).sort(([a], [b]) => a.localeCompare(b));
      const start = options.cursor ? matching.findIndex(([key]) => key === options.cursor) + 1 : 0;
      const page = matching.slice(start, start + options.limit);
      return { objects: page.map(([key, item]) => wrap(key, item)), truncated: start + options.limit < matching.length, cursor: page.at(-1)?.[0] };
    },
  };
}

function setup() {
  const storage = bucket();
  for (const [id, secret, app] of [["a".repeat(24), "x".repeat(43), "first"], ["b".repeat(24), "y".repeat(43), "second"]]) {
    storage.objects.set(`system/v1/keys/${id}.json`, {
      body: JSON.stringify({ id, secretHash: createHash("sha256").update(secret).digest("hex"), app, environment: "production", permissions: ["read", "write"] }),
      etag: id, metadata: {},
    });
  }
  const env = { BUCKET: storage, RATE_LIMITER: { limit: async () => ({ success: true }) }, CURSOR_SECRET: "a long secret with at least thirty-two bytes" };
  const call = (method: string, path: string, token = tokenA, data?: object, etag?: string) => worker.fetch(new Request(`https://example.test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(data ? { "content-type": "application/json" } : {}), ...(etag ? { "if-match": etag } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  }), env as never);
  return { call, storage };
}

describe("document API", () => {
  it("isolates apps and requires valid credentials", async () => {
    const { call } = setup();
    const path = "/v1/collections/notes/documents";
    expect((await call("POST", `${path}?id=one`, tokenA, { title: "hello" })).status).toBe(201);
    expect((await call("GET", `${path}/one`, tokenB)).status).toBe(404);
    expect((await call("GET", `${path}/one`, "bad")).status).toBe(401);
    expect((await call("GET", `${path}/one`, tokenA)).status).toBe(200);
  });

  it("protects writes with ETags and hides deleted documents", async () => {
    const { call } = setup();
    const path = "/v1/collections/notes/documents/one";
    const created = await call("POST", "/v1/collections/notes/documents?id=one", tokenA, { count: 1 });
    const oldEtag = created.headers.get("etag")!;
    expect((await call("PATCH", path, tokenA, { count: 2 })).status).toBe(428);
    const updated = await call("PATCH", path, tokenA, { count: 2 }, oldEtag);
    expect(updated.status).toBe(200);
    expect((await updated.json() as { data: { count: number } }).data.count).toBe(2);
    expect((await call("PUT", path, tokenA, { count: 3 }, oldEtag)).status).toBe(412);
    expect((await call("DELETE", path, tokenA, undefined, updated.headers.get("etag")!)).status).toBe(204);
    expect((await call("GET", path)).status).toBe(404);
    expect((await call("POST", "/v1/collections/notes/documents?id=one", tokenA, { count: 4 })).status).toBe(409);
  });

  it("binds list cursors to their collection", async () => {
    const { call } = setup();
    for (const id of ["a", "b"]) await call("POST", `/v1/collections/notes/documents?id=${id}`, tokenA, { id });
    const first = await call("GET", "/v1/collections/notes/documents?limit=1");
    const page = await first.json() as { documents: Array<{ id: string }>; cursor: string };
    expect(page.documents).toHaveLength(1);
    expect((await call("GET", `/v1/collections/notes/documents?limit=1&cursor=${page.cursor}`)).status).toBe(200);
    expect((await call("GET", `/v1/collections/other/documents?limit=1&cursor=${page.cursor}`)).status).toBe(400);
  });
});
