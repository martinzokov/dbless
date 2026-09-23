import { createServer } from "node:http";
import handler from "../api/handler";

const port = Number(process.env.DBLESS_PORT ?? 8787);

createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const request = new Request(`http://127.0.0.1:${port}${incoming.url ?? "/"}`, {
      method: incoming.method,
      headers: incoming.headers as HeadersInit,
      body: body.length ? body : undefined,
    });
    const response = await handler.fetch(request);
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (cause) {
    console.error("local_server_error", cause);
    outgoing.statusCode = 500;
    outgoing.end("Local server failed");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`dbless local API listening at http://127.0.0.1:${port}`);
});
