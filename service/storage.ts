import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Bucket, StoredObject } from "./index";

type Settings = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function settings(): Settings {
  return {
    accountId: required("R2_ACCOUNT_ID"),
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    bucket: required("R2_BUCKET"),
  };
}

function missing(cause: unknown): boolean {
  return !!cause && typeof cause === "object" && "name" in cause && ["NoSuchKey", "NotFound"].includes(String(cause.name));
}

function precondition(cause: unknown): boolean {
  return !!cause && typeof cause === "object" && "$metadata" in cause && typeof cause.$metadata === "object" && cause.$metadata !== null && "httpStatusCode" in cause.$metadata && cause.$metadata.httpStatusCode === 412;
}

export function createBucket(config: Settings = settings()): Bucket {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });

  return {
    async get(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        const body = await response.Body!.transformToString();
        const etag = response.ETag ?? "";
        return { key, etag: etag.replace(/^"|"$/g, ""), httpEtag: etag, json: async <T>() => JSON.parse(body) as T } satisfies StoredObject;
      } catch (cause) {
        if (missing(cause)) return null;
        throw cause;
      }
    },
    async put(key, value, options) {
      try {
        const response = await client.send(new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: value,
          ContentType: options.httpMetadata.contentType,
          Metadata: Object.fromEntries(Object.entries(options.customMetadata).map(([field, entry]) => [field.toLowerCase(), entry])),
          ...(options.onlyIf.has("if-none-match") ? { IfNoneMatch: options.onlyIf.get("if-none-match")! } : {}),
          ...(options.onlyIf.has("if-match") ? { IfMatch: options.onlyIf.get("if-match")! } : {}),
        }));
        const etag = response.ETag ?? "";
        return { key, etag: etag.replace(/^"|"$/g, ""), httpEtag: etag, json: async <T>() => JSON.parse(value) as T } satisfies StoredObject;
      } catch (cause) {
        if (precondition(cause)) return null;
        throw cause;
      }
    },
    async list(options) {
      const response = await client.send(new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: options.prefix,
        MaxKeys: options.limit,
        ContinuationToken: options.cursor,
      }));
      return {
        objects: (response.Contents ?? []).filter(item => !!item.Key).map(item => ({
          key: item.Key!,
          etag: (item.ETag ?? "").replace(/^"|"$/g, ""),
          httpEtag: item.ETag ?? "",
          json: async <T>() => { throw new Error("Listed objects do not include bodies"); },
        } satisfies StoredObject)),
        truncated: response.IsTruncated ?? false,
        cursor: response.NextContinuationToken,
      };
    },
  };
}
