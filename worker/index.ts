interface Env {
  BUCKET: R2Bucket;
  RATE_LIMITER: RateLimit;
  CURSOR_SECRET: string;
  MAX_DOCUMENT_BYTES?: string;
}

interface KeyRecord {
  id: string;
  secretHash: string;
  app: string;
  environment: string;
  permissions: Array<"read" | "write">;
  collections?: string[];
  expiresAt?: string;
  revokedAt?: string;
}

interface Document {
  id: string;
  revision: string;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  data: Record<string, unknown>;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const encoder = new TextEncoder();

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

async function authenticate(request: Request, env: Env): Promise<KeyRecord | null> {
  const match = /^Bearer dbj_live_([a-f0-9]{24})_([A-Za-z0-9_-]{32,})$/.exec(request.headers.get("authorization") ?? "");
  if (!match) return null;
  const object = await env.BUCKET.get(`system/v1/keys/${match[1]}.json`);
  if (!object) return null;
  let key: KeyRecord;
  try { key = await object.json<KeyRecord>(); } catch { return null; }
  if (key.id !== match[1] || key.revokedAt || (key.expiresAt && Date.parse(key.expiresAt) <= Date.now())) return null;
  const hash = await sha256(match[2]);
  return constantTimeEqual(hash, key.secretHash) ? key : null;
}

function objectKey(key: KeyRecord, collection: string, id: string): string {
  return `data/v1/${key.app}/${key.environment}/${collection}/${id}.json`;
}

function etag(object: R2Object): string { return object.httpEtag; }

async function bodyData(request: Request, maxBytes: number): Promise<Record<string, unknown> | Response> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > maxBytes) return error(413, "too_large", "Document exceeds the size limit");
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return error(415, "content_type", "Expected application/json");
  const reader = request.body?.getReader();
  if (!reader) return error(400, "invalid_json", "Expected a JSON object");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) { await reader.cancel(); return error(413, "too_large", "Document exceeds the size limit"); }
    chunks.push(value);
  }
  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not an object");
    const safe = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return true;
      return Object.entries(value).every(([field, entry]) => !["__proto__", "prototype", "constructor"].includes(field) && safe(entry));
    };
    if (!safe(data)) return error(400, "invalid_json", "Reserved field name");
    return data as Record<string, unknown>;
  } catch { return error(400, "invalid_json", "Expected a JSON object"); }
}

function metadata(doc: Document): Record<string, string> {
  return { id: doc.id, createdAt: doc.createdAt, updatedAt: doc.updatedAt, deleted: String(doc.deleted) };
}

async function store(env: Env, key: string, doc: Document, onlyIf: Headers): Promise<R2Object | null> {
  return env.BUCKET.put(key, JSON.stringify(doc), {
    onlyIf,
    httpMetadata: { contentType: "application/json" },
    customMetadata: metadata(doc),
  });
}

function encodeBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

async function cursorSignature(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return encodeBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
}

async function signCursor(state: object, secret: string): Promise<string> {
  const payload = encodeBase64(encoder.encode(JSON.stringify(state)));
  return `${payload}.${await cursorSignature(payload, secret)}`;
}

async function verifyCursor(value: string, secret: string): Promise<Record<string, unknown> | null> {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra || !constantTimeEqual(signature, await cursorSignature(payload, secret))) return null;
  try { return JSON.parse(new TextDecoder().decode(decodeBase64(payload))) as Record<string, unknown>; }
  catch { return null; }
}

function merge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) delete result[field];
    else if (typeof value === "object" && !Array.isArray(value)) {
      const old = result[field];
      result[field] = merge(old && typeof old === "object" && !Array.isArray(old) ? old as Record<string, unknown> : {}, value as Record<string, unknown>);
    } else result[field] = value;
  }
  return result;
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return json({ ok: true });
  const key = await authenticate(request, env);
  if (!key) return error(401, "unauthorized", "Invalid API key");
  if (!(await env.RATE_LIMITER.limit({ key: key.id })).success) return error(429, "rate_limited", "Too many requests");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts.length > 5 || parts[0] !== "v1" || parts[1] !== "collections" || parts[3] !== "documents") return error(404, "not_found", "Unknown endpoint");
  const collection = parts[2];
  const id = parts[4];
  if (!NAME.test(collection) || (id && !ID.test(id))) return error(400, "invalid_name", "Invalid collection or document ID");
  const write = request.method === "POST" || request.method === "PUT" || request.method === "PATCH" || request.method === "DELETE";
  if (!key.permissions.includes(write ? "write" : "read") || (key.collections && !key.collections.includes(collection))) return error(403, "forbidden", "Key lacks access to this collection");
  const maxBytes = Number(env.MAX_DOCUMENT_BYTES || 262144);

  if (!id && request.method === "POST") {
    const input = await bodyData(request, maxBytes);
    if (input instanceof Response) return input;
    const suppliedId = url.searchParams.get("id");
    if (suppliedId && !ID.test(suppliedId)) return error(400, "invalid_name", "Invalid document ID");
    const docId = suppliedId ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const doc: Document = { id: docId, revision: crypto.randomUUID(), createdAt: now, updatedAt: now, deleted: false, data: input };
    if (encoder.encode(JSON.stringify(doc)).byteLength > maxBytes) return error(413, "too_large", "Document exceeds the size limit");
    const result = await store(env, objectKey(key, collection, docId), doc, new Headers({ "If-None-Match": "*" }));
    return result ? json(doc, 201, { etag: etag(result), location: `${url.pathname}/${docId}` }) : error(409, "exists", "Document ID already exists");
  }

  if (!id && request.method === "GET") {
    if (!env.CURSOR_SECRET || encoder.encode(env.CURSOR_SECRET).byteLength < 32) return error(500, "configuration", "Cursor secret is missing or too short");
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const prefix = url.searchParams.get("prefix") ?? "";
    const includeData = url.searchParams.get("include") === "data";
    if (!Number.isInteger(limit) || limit < 1 || limit > (includeData ? 20 : 100) || (prefix && !ID.test(prefix))) return error(400, "invalid_query", "Invalid limit or prefix");
    if (url.searchParams.has("include") && !includeData) return error(400, "invalid_query", "Unsupported include value");
    const base = `data/v1/${key.app}/${key.environment}/${collection}/`;
    let cursor: string | undefined;
    const token = url.searchParams.get("cursor");
    if (token) {
      const state = await verifyCursor(token, env.CURSOR_SECRET);
      if (!state || state.scope !== `${base}|${prefix}|${includeData}` || typeof state.cursor !== "string") return error(400, "invalid_cursor", "Invalid cursor");
      cursor = state.cursor;
    }
    const listed = await env.BUCKET.list({ prefix: `${base}${prefix}`, limit, cursor, include: ["customMetadata"] });
    const documents = await Promise.all(listed.objects.filter(object => object.customMetadata?.deleted !== "true").map(async object => {
      const summary = { id: object.customMetadata?.id ?? object.key.slice(base.length, -5), createdAt: object.customMetadata?.createdAt ?? object.customMetadata?.createdat, updatedAt: object.customMetadata?.updatedAt ?? object.customMetadata?.updatedat, etag: etag(object) };
      if (!includeData) return summary;
      const full = await env.BUCKET.get(object.key);
      return full ? { ...summary, data: (await full.json<Document>()).data } : null;
    }));
    const nextCursor = listed.truncated && listed.cursor ? await signCursor({ scope: `${base}|${prefix}|${includeData}`, cursor: listed.cursor }, env.CURSOR_SECRET) : null;
    return json({ documents: documents.filter(Boolean), cursor: nextCursor });
  }

  if (!id) return error(405, "method_not_allowed", "Unsupported method");
  if (!["GET", "PUT", "PATCH", "DELETE"].includes(request.method)) return error(405, "method_not_allowed", "Unsupported method");
  const path = objectKey(key, collection, id);
  const object = await env.BUCKET.get(path);
  if (!object) return error(404, "not_found", "Document not found");
  const doc = await object.json<Document>();
  if (doc.deleted) return error(404, "not_found", "Document not found");
  if (request.method === "GET") return json(doc, 200, { etag: etag(object) });
  const match = request.headers.get("if-match");
  if (!match) return error(428, "precondition_required", "If-Match is required");
  if (match !== etag(object)) return error(412, "precondition_failed", "Document changed; read it again");
  let data = doc.data;
  if (request.method !== "DELETE") {
    const input = await bodyData(request, maxBytes);
    if (input instanceof Response) return input;
    data = request.method === "PATCH" ? merge(data, input) : input;
  } else data = {};
  const updated: Document = { ...doc, data, revision: crypto.randomUUID(), updatedAt: new Date().toISOString(), deleted: request.method === "DELETE" };
  if (encoder.encode(JSON.stringify(updated)).byteLength > maxBytes) return error(413, "too_large", "Document exceeds the size limit");
  const result = await store(env, path, updated, new Headers({ "If-Match": etag(object) }));
  if (!result) return error(412, "precondition_failed", "Document changed; read it again");
  return request.method === "DELETE" ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } }) : json(updated, 200, { etag: etag(result) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await handle(request, env); }
    catch (cause) {
      console.error("request_failed", cause);
      return error(500, "internal_error", "Storage request failed");
    }
  },
};
