export interface StoredDocument<T> {
  id: string;
  revision: string;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  data: T;
  etag: string;
}

export class StoreError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export function createStore(config: { url: string; apiKey: string; fetch?: typeof fetch }) {
  const request = async <T>(method: string, path: string, data?: unknown, etag?: string): Promise<{ value: T; etag: string }> => {
    const response = await (config.fetch ?? fetch)(`${config.url.replace(/\/$/, "")}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.apiKey}`, ...(data === undefined ? {} : { "content-type": "application/json" }), ...(etag ? { "if-match": etag } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data),
      cache: "no-store",
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
      throw new StoreError(response.status, body.error?.code ?? "unknown", body.error?.message ?? `HTTP ${response.status}`);
    }
    return { value: response.status === 204 ? undefined as T : await response.json() as T, etag: response.headers.get("etag") ?? "" };
  };
  return {
    collection<T extends object>(name: string) {
      const base = `/v1/collections/${encodeURIComponent(name)}/documents`;
      return {
        async create(options: { data: T; id?: string }): Promise<StoredDocument<T>> {
          const path = options.id ? `${base}?id=${encodeURIComponent(options.id)}` : base;
          const result = await request<Omit<StoredDocument<T>, "etag">>("POST", path, options.data);
          return { ...result.value, etag: result.etag };
        },
        async get(id: string): Promise<StoredDocument<T>> {
          const result = await request<Omit<StoredDocument<T>, "etag">>("GET", `${base}/${encodeURIComponent(id)}`);
          return { ...result.value, etag: result.etag };
        },
        async put(id: string, data: T, options: { ifMatch: string }): Promise<StoredDocument<T>> {
          const result = await request<Omit<StoredDocument<T>, "etag">>("PUT", `${base}/${encodeURIComponent(id)}`, data, options.ifMatch);
          return { ...result.value, etag: result.etag };
        },
        async patch(id: string, patch: Partial<T>, options: { ifMatch: string }): Promise<StoredDocument<T>> {
          const result = await request<Omit<StoredDocument<T>, "etag">>("PATCH", `${base}/${encodeURIComponent(id)}`, patch, options.ifMatch);
          return { ...result.value, etag: result.etag };
        },
        async delete(id: string, options: { ifMatch: string }): Promise<void> {
          await request<void>("DELETE", `${base}/${encodeURIComponent(id)}`, undefined, options.ifMatch);
        },
        async list(options: { limit?: number; cursor?: string; prefix?: string; includeData?: boolean } = {}): Promise<{ documents: Array<{ id: string; createdAt: string; updatedAt: string; etag: string; data?: T }>; cursor: string | null }> {
          const query = new URLSearchParams();
          if (options.limit) query.set("limit", String(options.limit));
          if (options.cursor) query.set("cursor", options.cursor);
          if (options.prefix) query.set("prefix", options.prefix);
          if (options.includeData) query.set("include", "data");
          const suffix = query.size ? `?${query}` : "";
          return (await request<{ documents: Array<{ id: string; createdAt: string; updatedAt: string; etag: string; data?: T }>; cursor: string | null }>("GET", `${base}${suffix}`)).value;
        },
      };
    },
  };
}
