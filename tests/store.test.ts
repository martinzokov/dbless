import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { createStore, StoreError } from "../src/index";

function fakeR2() {
  const objects = new Map<string, { body: string; etag: string }>();
  let version = 0;
  const client = {
    async send(command: unknown) {
      if (command instanceof GetObjectCommand) {
        const object = objects.get(command.input.Key!);
        if (!object) throw { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } };
        return { ETag: object.etag, Body: { transformToString: async () => object.body } };
      }
      if (command instanceof PutObjectCommand) {
        const key = command.input.Key!;
        const current = objects.get(key);
        if ((command.input.IfNoneMatch === "*" && current) || (command.input.IfMatch && command.input.IfMatch !== current?.etag)) {
          throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
        }
        const object = { body: String(command.input.Body), etag: `"${++version}"` };
        objects.set(key, object);
        return { ETag: object.etag };
      }
      if (command instanceof ListObjectsV2Command) {
        const matches = [...objects.keys()].filter(key => key.startsWith(command.input.Prefix ?? "")).sort();
        const start = Number(command.input.ContinuationToken ?? 0);
        const page = matches.slice(start, start + (command.input.MaxKeys ?? 1000));
        const next = start + page.length;
        return { Contents: page.map(Key => ({ Key })), IsTruncated: next < matches.length, NextContinuationToken: next < matches.length ? String(next) : undefined };
      }
      throw new Error("Unexpected S3 command");
    },
  } as unknown as S3Client;
  const store = (app: string) => createStore({ accountId: "test", bucket: "shared", accessKeyId: "test", secretAccessKey: "test", app, environment: "local", client });
  return { store, objects };
}

describe("direct R2 store", () => {
  it("uses separate object prefixes for apps in one bucket", async () => {
    const { store, objects } = fakeR2();
    const first = store("first").collection<{ title: string }>("notes");
    const second = store("second").collection<{ title: string }>("notes");
    await first.create({ id: "one", data: { title: "first app" } });
    expect(await first.get("one")).toMatchObject({ data: { title: "first app" } });
    await expect(second.get("one")).rejects.toMatchObject({ status: 404 });
    expect([...objects.keys()]).toEqual(["data/v1/first/local/notes/one.json"]);
  });

  it("rejects stale writes and duplicate IDs, then hides tombstones", async () => {
    const { store } = fakeR2();
    const notes = store("first").collection<{ title: string; done: boolean }>("notes");
    const created = await notes.create({ id: "one", data: { title: "task", done: false } });
    await expect(notes.create({ id: "one", data: { title: "duplicate", done: false } })).rejects.toMatchObject({ status: 409 });
    const updated = await notes.patch("one", { done: true }, { ifMatch: created.etag });
    expect(updated.data.done).toBe(true);
    await expect(notes.put("one", { title: "stale", done: false }, { ifMatch: created.etag })).rejects.toMatchObject({ status: 412 });
    await notes.delete("one", { ifMatch: updated.etag });
    await expect(notes.get("one")).rejects.toBeInstanceOf(StoreError);
    expect((await notes.list()).documents).toEqual([]);
  });

  it("lists JSON data with a bounded page and cursor", async () => {
    const { store } = fakeR2();
    const notes = store("first").collection<{ title: string }>("notes");
    await notes.create({ id: "one", data: { title: "one" } });
    await notes.create({ id: "two", data: { title: "two" } });
    const first = await notes.list({ limit: 1, includeData: true });
    expect(first.documents[0]?.data?.title).toBe("one");
    expect(first.cursor).toBeTruthy();
    const second = await notes.list({ limit: 1, includeData: true, cursor: first.cursor! });
    expect(second.documents[0]?.data?.title).toBe("two");
    expect(second.cursor).toBeNull();
  });
});
