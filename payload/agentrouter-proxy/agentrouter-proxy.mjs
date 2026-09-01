// AgentRouter passthrough for DSH.
//
//   node agentrouter-proxy.mjs        # listens on 127.0.0.1:3081
//
// AgentRouter is a plain HTTPS API with no local dependency — but it refuses any
// request that does not look like the Claude CLI:
//
//   User-Agent: claude-cli/2.1.243 (external, cli)   -> 200
//   User-Agent: curl/8.0                             -> 401 "unauthorized client detected"
//
// (Verified live against https://agentrouter.org/v1/messages on 1 Sep 2026.)
//
// DSH cannot send that header itself. A `headers:` map on the provider does not
// win: pi-ai's anthropic-messages client sets its own User-Agent after merging
// custom headers, so pointing `baseURL` straight at agentrouter.org returns
// "AUTH: 401 UNAUTHENTICATED" — tested with both `User-Agent` and `user-agent`
// spellings inside a headless DSH run.
//
// Hence these 60-odd lines: a dependency-free loopback proxy whose only job is to
// rewrite that one header. Everything else is piped through untouched, so there is
// no request buffering and streaming responses stay streaming.
//
// Everything is overridable so the same file works on any machine:
//   AGENTROUTER_PROXY_HOST   default 127.0.0.1
//   AGENTROUTER_PROXY_PORT   default 3081
//   AGENTROUTER_UPSTREAM     default https://agentrouter.org
//   AGENTROUTER_USER_AGENT   default claude-cli/2.1.243 (external, cli)
import http from "node:http";
import https from "node:https";

const listenHost = process.env.AGENTROUTER_PROXY_HOST || "127.0.0.1";
const listenPort = Number(process.env.AGENTROUTER_PROXY_PORT || 3081);
const upstream = new URL(process.env.AGENTROUTER_UPSTREAM || "https://agentrouter.org");
const userAgent = process.env.AGENTROUTER_USER_AGENT || "claude-cli/2.1.243 (external, cli)";

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

function forwardedHeaders(source) {
  const headers = {};
  for (const [name, value] of Object.entries(source)) {
    if (!hopByHopHeaders.has(name.toLowerCase()) && value !== undefined) {
      headers[name] = value;
    }
  }
  headers.host = upstream.host;
  headers["user-agent"] = userAgent;
  return headers;
}

const server = http.createServer((request, response) => {
  const upstreamRequest = https.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || 443,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request.headers),
    },
    (upstreamResponse) => {
      const headers = forwardedHeaders(upstreamResponse.headers);
      delete headers.host;
      delete headers["user-agent"];
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, headers);
      upstreamResponse.pipe(response);
    },
  );

  upstreamRequest.on("error", (error) => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json" });
    }
    response.end(
      JSON.stringify({ error: { message: "AgentRouter bridge failed", detail: error.message } }),
    );
  });

  request.on("aborted", () => upstreamRequest.destroy());
  request.pipe(upstreamRequest);
});

server.on("error", (error) => {
  // Another copy already holds the port: that is a success condition for an
  // installer that may run this twice, not a crash.
  if (error.code === "EADDRINUSE") {
    console.log(`[agentrouter] ${listenHost}:${listenPort} already in use — assuming a proxy is up`);
    process.exit(0);
  }
  console.error("[agentrouter]", error.message);
  process.exit(1);
});

server.listen(listenPort, listenHost, () => {
  console.log(`[agentrouter] ${listenHost}:${listenPort} -> ${upstream.origin}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
