import service from "../service/index";
import type { Bucket } from "../service/index";
import { createBucket } from "../service/storage";

let bucket: Bucket | undefined;

export default {
  async fetch(request: Request): Promise<Response> {
    return service.fetch(request, {
      BUCKET: bucket ??= createBucket(),
      CURSOR_SECRET: process.env.CURSOR_SECRET ?? "",
      MAX_DOCUMENT_BYTES: process.env.MAX_DOCUMENT_BYTES,
    });
  },
};
