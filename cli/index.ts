import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const client = new S3Client({
  region: "auto",
  endpoint: `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: required("R2_ACCESS_KEY_ID"), secretAccessKey: required("R2_SECRET_ACCESS_KEY") },
});
const bucket = required("R2_BUCKET");

async function read<T>(key: string): Promise<T | null> {
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await result.Body!.transformToString()) as T;
  } catch (cause) {
    if (cause && typeof cause === "object" && "name" in cause && (cause.name === "NoSuchKey" || cause.name === "NotFound")) return null;
    throw cause;
  }
}

async function write(key: string, value: unknown, condition?: "create" | string): Promise<void> {
  await client.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: JSON.stringify(value), ContentType: "application/json",
    ...(condition === "create" ? { IfNoneMatch: "*" } : condition ? { IfMatch: condition } : {}),
  }));
}

function name(value: string | undefined, label: string): string {
  if (!value || !NAME.test(value)) throw new Error(`${label} must be 1–64 lowercase letters, digits, _ or -`);
  return value;
}

async function main(): Promise<void> {
  const [entity, action, ...args] = process.argv.slice(2);
  if (entity === "app" && action === "create") {
    const app = name(args[0], "app");
    await write(`system/v1/apps/${app}.json`, { id: app, createdAt: new Date().toISOString() }, "create");
    console.log(`Created app ${app}`);
    return;
  }
  if (entity === "app" && action === "export") {
    const app = name(args[0], "app");
    const environment = name(args[1], "environment");
    const prefix = `data/v1/${app}/${environment}/`;
    let cursor: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: cursor }));
      for (const item of page.Contents ?? []) {
        if (!item.Key?.endsWith(".json")) continue;
        const value = await read<Record<string, unknown>>(item.Key);
        if (value) console.log(JSON.stringify({ key: item.Key, document: value }));
      }
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (cursor);
    return;
  }
  if (entity === "app" && action === "import") {
    const app = name(args[0], "app");
    const environment = name(args[1], "environment");
    const file = args[2];
    if (!file) throw new Error("Import requires an NDJSON file path");
    const prefix = `data/v1/${app}/${environment}/`;
    let count = 0;
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { key?: unknown; document?: Record<string, unknown> };
      const key = entry.key;
      const doc = entry.document;
      if (typeof key !== "string" || !key.startsWith(prefix) || !doc) throw new Error(`Invalid import entry at line ${count + 1}`);
      const suffix = key.slice(prefix.length);
      const match = /^([a-z0-9][a-z0-9_-]{0,63})\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/.exec(suffix);
      if (!match || doc.id !== match[2] || typeof doc.revision !== "string" || typeof doc.createdAt !== "string" || typeof doc.updatedAt !== "string" || typeof doc.deleted !== "boolean" || !doc.data || typeof doc.data !== "object" || Array.isArray(doc.data)) throw new Error(`Invalid document at line ${count + 1}`);
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: JSON.stringify(doc), ContentType: "application/json", IfNoneMatch: "*",
        Metadata: { id: doc.id, createdat: doc.createdAt, updatedat: doc.updatedAt, deleted: String(doc.deleted) },
      }));
      count++;
    }
    console.log(`Imported ${count} documents into ${app}/${environment}`);
    return;
  }
  if (entity === "key" && action === "create") {
    const app = name(args[0], "app");
    const environment = name(args[1], "environment");
    const permissions = args[2] === "read" ? ["read"] : args[2] === "write" ? ["read", "write"] : null;
    if (!permissions) throw new Error("permission must be read or write");
    if (!await read(`system/v1/apps/${app}.json`)) throw new Error(`App ${app} does not exist`);
    const collections = args[3] ? args[3].split(",").map((value: string) => name(value, "collection")) : undefined;
    const id = Buffer.from(randomBytes(12)).toString("hex");
    const secret = Buffer.from(randomBytes(32)).toString("base64url");
    await write(`system/v1/keys/${id}.json`, {
      id, secretHash: createHash("sha256").update(secret).digest("hex"), app, environment,
      permissions, ...(collections ? { collections } : {}), createdAt: new Date().toISOString(),
    }, "create");
    console.log(`Key ID: ${id}\nAPI key (shown once): dbj_live_${id}_${secret}`);
    return;
  }
  if (entity === "key" && action === "revoke") {
    const id = args[0];
    if (!id || !/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid key ID");
    const path = `system/v1/keys/${id}.json`;
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: path }));
    const record = JSON.parse(await result.Body!.transformToString()) as Record<string, unknown>;
    await write(path, { ...record, revokedAt: new Date().toISOString() }, result.ETag);
    console.log(`Revoked key ${id}`);
    return;
  }
  throw new Error("Usage: admin app create <app> | app export <app> <environment> | app import <app> <environment> <file.ndjson> | key create <app> <environment> <read|write> [collection1,collection2] | key revoke <key-id>");
}

main().catch(cause => { console.error(cause instanceof Error ? cause.message : cause); process.exitCode = 1; });
