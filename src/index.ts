import { randomUUID } from "node:crypto";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface StoreConfig {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  app: string;
  environment?: string;
  maxDocumentBytes?: number;
  /** Supply an S3-compatible client for tests or custom transports. */
  client?: S3Client;
}

export interface StoredDocument<T> {
  id: string;
  revision: string;
  createdAt: string;
  updatedAt: string;
  data: T;
  etag: string;
}

export interface DocumentSummary<T> {
  id: string;
  createdAt: string;
  updatedAt: string;
  etag: string;
  data?: T;
}

interface FileDocument<T> extends Omit<StoredDocument<T>, "etag"> {
  deleted: boolean;
}

export class StoreError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "StoreError";
  }
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function validName(value: string, label: string): void {
  if (!NAME.test(value)) throw new StoreError(400, "invalid_name", `Invalid ${label}`);
}

function validId(value: string): void {
  if (!ID.test(value)) throw new StoreError(400, "invalid_id", "Invalid document ID");
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateData(value: unknown): asserts value is Record<string, unknown> {
  if (!isObject(value)) throw new StoreError(400, "invalid_json", "Document data must be a JSON object");
  const seen = new WeakSet<object>();
  const safe = (entry: unknown): boolean => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return true;
    if (typeof entry === "number") return Number.isFinite(entry);
    if (typeof entry !== "object" || seen.has(entry)) return false;
    seen.add(entry);
    const valid = Array.isArray(entry)
      ? entry.every(safe)
      : isObject(entry) && Object.entries(entry).every(([field, child]) => !["__proto__", "prototype", "constructor"].includes(field) && safe(child));
    seen.delete(entry);
    return valid;
  };
  if (!safe(value)) throw new StoreError(400, "invalid_json", "Reserved field name");
}

function merge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) delete result[field];
    else if (isObject(value)) result[field] = merge(isObject(result[field]) ? result[field] : {}, value);
    else result[field] = value;
  }
  return result;
}

function statusOf(cause: unknown): number | undefined {
  if (!cause || typeof cause !== "object" || !("$metadata" in cause)) return undefined;
  const metadata = cause.$metadata;
  return metadata && typeof metadata === "object" && "httpStatusCode" in metadata && typeof metadata.httpStatusCode === "number"
    ? metadata.httpStatusCode : undefined;
}

function etag(value: string | undefined): string {
  if (!value) throw new StoreError(500, "missing_etag", "R2 did not return an ETag");
  return value;
}

export function createStore(config: StoreConfig) {
  validName(config.app, "app name");
  const environment = config.environment ?? "production";
  validName(environment, "environment");
  if (!config.bucket) throw new Error("R2 bucket is required");
  if (!config.client && (!config.accountId || !config.accessKeyId || !config.secretAccessKey)) throw new Error("R2 account ID and access key pair are required");
  const maxBytes = config.maxDocumentBytes ?? 262144;
  if (!Number.isInteger(maxBytes) || maxBytes < 1024) throw new Error("maxDocumentBytes must be an integer of at least 1024");
  const client = config.client ?? new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  const prefix = `data/v1/${config.app}/${environment}/`;

  async function read<T>(key: string): Promise<{ doc: FileDocument<T>; etag: string } | null> {
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      const doc = JSON.parse(await response.Body!.transformToString()) as FileDocument<T>;
      return { doc, etag: etag(response.ETag) };
    } catch (cause) {
      if (statusOf(cause) === 404 || (cause instanceof Error && ["NoSuchKey", "NotFound"].includes(cause.name))) return null;
      throw cause;
    }
  }

  async function write<T>(key: string, doc: FileDocument<T>, condition: { ifMatch?: string; ifNoneMatch?: boolean }): Promise<string> {
    let body: string;
    try { body = JSON.stringify(doc); }
    catch { throw new StoreError(400, "invalid_json", "Document cannot be serialized as JSON"); }
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new StoreError(413, "too_large", "Document exceeds the size limit");
    try {
      const response = await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
        Metadata: { id: doc.id, createdat: doc.createdAt, updatedat: doc.updatedAt, deleted: String(doc.deleted) },
        ...(condition.ifNoneMatch ? { IfNoneMatch: "*" } : {}),
        ...(condition.ifMatch ? { IfMatch: condition.ifMatch } : {}),
      }));
      return etag(response.ETag);
    } catch (cause) {
      if (statusOf(cause) === 412 || statusOf(cause) === 409) {
        throw condition.ifNoneMatch
          ? new StoreError(409, "exists", "Document ID already exists")
          : new StoreError(412, "precondition_failed", "Document changed; read it again");
      }
      throw cause;
    }
  }

  return {
    collection<T extends object>(name: string) {
      validName(name, "collection name");
      const base = `${prefix}${name}/`;
      const path = (id: string) => { validId(id); return `${base}${id}.json`; };
      return {
        async create(options: { data: T; id?: string }): Promise<StoredDocument<T>> {
          validateData(options.data);
          const id = options.id ?? randomUUID();
          const key = path(id);
          const now = new Date().toISOString();
          const doc: FileDocument<T> = { id, revision: randomUUID(), createdAt: now, updatedAt: now, deleted: false, data: options.data };
          const version = await write(key, doc, { ifNoneMatch: true });
          return { id, revision: doc.revision, createdAt: now, updatedAt: now, data: doc.data, etag: version };
        },
        async get(id: string): Promise<StoredDocument<T>> {
          const result = await read<T>(path(id));
          if (!result || result.doc.deleted) throw new StoreError(404, "not_found", "Document not found");
          const { deleted: _deleted, ...doc } = result.doc;
          return { ...doc, etag: result.etag };
        },
        async put(id: string, data: T, options: { ifMatch: string }): Promise<StoredDocument<T>> {
          validateData(data);
          return update(id, data, options.ifMatch, false);
        },
        async patch(id: string, patch: Partial<T>, options: { ifMatch: string }): Promise<StoredDocument<T>> {
          validateData(patch);
          return update(id, patch, options.ifMatch, true);
        },
        async delete(id: string, options: { ifMatch: string }): Promise<void> {
          if (!options.ifMatch) throw new StoreError(428, "precondition_required", "ifMatch is required");
          const key = path(id);
          const result = await read<T>(key);
          if (!result || result.doc.deleted) throw new StoreError(404, "not_found", "Document not found");
          if (result.etag !== options.ifMatch) throw new StoreError(412, "precondition_failed", "Document changed; read it again");
          await write(key, { ...result.doc, revision: randomUUID(), updatedAt: new Date().toISOString(), deleted: true, data: {} as T }, { ifMatch: result.etag });
        },
        async list(options: { limit?: number; cursor?: string; prefix?: string; includeData?: boolean } = {}): Promise<{ documents: DocumentSummary<T>[]; cursor: string | null }> {
          const includeData = options.includeData ?? false;
          const limit = options.limit ?? (includeData ? 20 : 50);
          if (!Number.isInteger(limit) || limit < 1 || limit > (includeData ? 20 : 100)) throw new StoreError(400, "invalid_query", "Invalid page limit");
          if (options.prefix) validId(options.prefix);
          const response = await client.send(new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: `${base}${options.prefix ?? ""}`,
            MaxKeys: limit,
            ContinuationToken: options.cursor,
          }));
          const documents = await Promise.all((response.Contents ?? []).map(async item => {
            if (!item.Key) return null;
            const result = await read<T>(item.Key);
            if (!result || result.doc.deleted) return null;
            const summary: DocumentSummary<T> = { id: result.doc.id, createdAt: result.doc.createdAt, updatedAt: result.doc.updatedAt, etag: result.etag };
            if (includeData) summary.data = result.doc.data;
            return summary;
          }));
          return { documents: documents.filter((item): item is DocumentSummary<T> => !!item), cursor: response.IsTruncated ? response.NextContinuationToken ?? null : null };
        },
      };

      async function update(id: string, input: T | Partial<T>, expected: string, patch: boolean): Promise<StoredDocument<T>> {
        if (!expected) throw new StoreError(428, "precondition_required", "ifMatch is required");
        const key = path(id);
        const result = await read<T>(key);
        if (!result || result.doc.deleted) throw new StoreError(404, "not_found", "Document not found");
        if (result.etag !== expected) throw new StoreError(412, "precondition_failed", "Document changed; read it again");
        const data = patch ? merge(result.doc.data as Record<string, unknown>, input as Record<string, unknown>) as T : input as T;
        const doc: FileDocument<T> = { ...result.doc, data, revision: randomUUID(), updatedAt: new Date().toISOString() };
        const version = await write(key, doc, { ifMatch: result.etag });
        const { deleted: _deleted, ...publicDoc } = doc;
        return { ...publicDoc, etag: version };
      }
    },
  };
}
