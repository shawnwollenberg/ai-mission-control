import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";

const [listenPort, targetPort, keyPath, certPath] = process.argv.slice(2);
if (!listenPort || !targetPort || !keyPath || !certPath) throw new Error("proxy arguments are required");

const server = https.createServer(
  { key: await readFile(keyPath), cert: await readFile(certPath) },
  (request, response) => {
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(targetPort),
        method: request.method,
        path: request.url,
        headers: { ...request.headers, host: `127.0.0.1:${targetPort}` },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", (error) => {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "disposable_proxy_failure", detail: error.message }));
    });
    request.pipe(upstream);
  },
);
server.listen(Number(listenPort), "127.0.0.1");
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
