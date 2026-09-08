import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { shouldAllowEnrollment, validateManagerUrl } from "../src/protocol.js";
import { ManagerTunnel } from "../src/tunnel.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}
function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}
function closeWebSocketServer(server) {
  for (const socket of server.clients) socket.terminate();
  return new Promise((resolve) => server.close(resolve));
}
function rejectUpgrade(socket, status = 401) {
  socket.end(
    `HTTP/1.1 ${status} Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function messageQueue(socket) {
  const queue = [];
  const waiters = [];
  socket.on("message", (raw) => {
    let value;
    try {
      value = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    const index = waiters.findIndex((waiter) => waiter.predicate(value));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    } else queue.push(value);
  });
  return (predicate, timeout = 3000) => {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error("timed out waiting for manager message"));
        }, timeout),
      };
      waiters.push(waiter);
    });
  };
}

function binaryMessageQueue(socket) {
  const queue = [];
  const waiters = [];
  socket.on("message", (raw, isBinary) => {
    if (!isBinary) return;
    const data = Buffer.from(raw);
    const separator = data.indexOf(10);
    if (separator <= 0) return;
    let value;
    try {
      value = JSON.parse(data.subarray(0, separator).toString("utf8"));
    } catch {
      return;
    }
    value.bodyBytes = data.subarray(separator + 1);
    const index = waiters.findIndex((waiter) => waiter.predicate(value));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    } else queue.push(value);
  });
  return (predicate, timeout = 3000) => {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error("timed out waiting for binary manager message"));
        }, timeout),
      };
      waiters.push(waiter);
    });
  };
}

test("rejected saved credentials wait for a new pairing code", async () => {
  let enrollmentRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/api/v1/agents/enroll") enrollmentRequests++;
    response.writeHead(404);
    response.end();
  });
  server.on("upgrade", (_request, socket) => rejectUpgrade(socket));
  const tunnel = new ManagerTunnel({
    serverUrl: `http://127.0.0.1:${await listen(server)}`,
    agentId: "agent-old",
    agentToken: "token-old",
    pairingCode: "stale",
    allowEnrollment: false,
    localOrigin: "http://127.0.0.1:1",
  });
  try {
    await tunnel.start();
    assert.equal(enrollmentRequests, 0);
    assert.equal(tunnel.agentId, "");
    assert.equal(tunnel.agentToken, "");
  } finally {
    tunnel.close();
    await closeServer(server);
  }
});

test("ordinary HTTP manager connection registers with Agent credentials", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  let headers;
  server.on("upgrade", (request, socket, head) => {
    headers = request.headers;
    wss.handleUpgrade(request, socket, head, (websocket) =>
      wss.emit("connection", websocket),
    );
  });
  const tunnel = new ManagerTunnel({
    serverUrl: `http://127.0.0.1:${await listen(server)}`,
    agentId: "agent-existing",
    agentToken: "token-existing",
    localOrigin: "http://127.0.0.1:1",
  });
  try {
    await tunnel.start();
    assert.equal(headers.authorization, "Bearer token-existing");
    assert.equal(headers["x-agent-id"], "agent-existing");
  } finally {
    tunnel.close();
    await closeWebSocketServer(wss);
    await closeServer(server);
  }
});

test("first enrollment remains allowed when credentials are absent", () => {
  assert.equal(
    shouldAllowEnrollment({
      agentId: "",
      agentToken: "",
      pairingCode: "current",
      pairingChanged: false,
      managerChanged: false,
    }),
    true,
  );
  assert.equal(
    shouldAllowEnrollment({
      agentId: "agent",
      agentToken: "token",
      pairingCode: "current",
      pairingChanged: false,
      managerChanged: false,
    }),
    false,
  );
});

test("manager URLs allow ordinary HTTP and HTTPS without port heuristics", () => {
  assert.equal(
    validateManagerUrl("http://manager.example:10090").protocol,
    "http:",
  );
  assert.equal(
    validateManagerUrl("https://manager.example:10090").protocol,
    "https:",
  );
  assert.throws(() => validateManagerUrl("wss://manager.example"), /http/);
});

test("buffered HTTP proxy response respects configured byte limit", async () => {
  const local = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Length": "5" });
    response.end("hello");
  });
  const localPort = await listen(local);
  const tunnel = new ManagerTunnel({
    serverUrl: "http://127.0.0.1:1",
    localOrigin: "http://127.0.0.1:" + localPort,
    maxBufferedResponseBytes: 4,
  });
  const messages = [];
  tunnel.socket = {
    readyState: WebSocket.OPEN,
    send(payload) {
      messages.push(JSON.parse(payload));
    },
    close() {},
  };
  try {
    await tunnel.proxyHttp({
      type: "proxy_request",
      requestId: "too-large",
      method: "GET",
      path: "/",
      headers: {},
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].status, 502);
    assert.match(messages[0].error, /exceeds buffer limit/);
    assert.equal(tunnel.activeHttpRequests.size, 0);
    assert.equal(tunnel.proxyMetrics.failed, 1);
  } finally {
    tunnel.close();
    await closeServer(local);
  }
});

test("DSH startup bootstrap and authenticated WebSocket Cookie pass through the plugin", async () => {
  let bootstrapTokenSeen = false;
  let websocketCookie = "";
  let slowResponseClosed;
  const slowResponseClosedPromise = new Promise((resolve) => {
    slowResponseClosed = resolve;
  });
  const local = http.createServer((request, response) => {
    if (request.url === "/?token=secret") {
      bootstrapTokenSeen = true;
      response.writeHead(303, {
        Location: "/",
        "Set-Cookie": "dsh-auth-test=ok; Path=/",
      });
      response.end();
      return;
    }
    if (
      request.url === "/" &&
      request.headers.cookie?.includes("dsh-auth-test=ok")
    ) {
      const body = gzipSync(Buffer.from("bootstrapped"));
      response.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Encoding": "gzip",
        Vary: "Accept-Encoding",
      });
      response.end(body);
      return;
    }
    if (request.url === "/stream") {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(Buffer.alloc(128 * 1024, 7));
      return;
    }
    if (request.url === "/slow") {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write("first");
      response.once("close", slowResponseClosed);
      const timer = setTimeout(() => response.end("late"), 5000);
      timer.unref();
      return;
    }
    if (request.url === "/assets/test.js") {
      const body = gzipSync(Buffer.from("binary-asset"));
      response.writeHead(200, {
        "Content-Type": "text/javascript",
        "Content-Encoding": "gzip",
        Vary: "Accept-Encoding",
      });
      response.end(body);
      return;
    }
    response.writeHead(401);
    response.end("dsh web authentication required");
  });
  const localWss = new WebSocketServer({ noServer: true });
  local.on("upgrade", (request, socket, head) => {
    if (
      request.url !== "/api/remote.mux" ||
      request.headers.cookie !== "dsh-auth-test=ok"
    ) {
      rejectUpgrade(socket);
      return;
    }
    websocketCookie = request.headers.cookie;
    localWss.handleUpgrade(request, socket, head, (websocket) => {
      localWss.emit("connection", websocket);
      websocket.on("message", (data, isBinary) => {
        if (isBinary) websocket.send(data, { binary: true });
      });
      websocket.send("pong");
    });
  });
  const localPort = await listen(local);
  const manager = http.createServer((request, response) => {
    if (request.url === "/api/v1/agents/enroll") {
      request.resume();
      request.on("end", () => {
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            agentId: "agent-e2e",
            agentToken: "token-e2e",
            protocolVersion: 1,
          }),
        );
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const managerWss = new WebSocketServer({ noServer: true });
  manager.on("upgrade", (request, socket, head) => {
    if (request.url !== "/api/v1/agent/connect") {
      rejectUpgrade(socket, 404);
      return;
    }
    managerWss.handleUpgrade(request, socket, head, (websocket) => {
      managerWss.emit("connection", websocket);
    });
  });
  const managerPort = await listen(manager);
  let managerSocket;
  let nextManagerMessage;
  let nextBinaryManagerMessage;
  const managerConnected = new Promise((resolve) => {
    managerWss.once("connection", (socket) => {
      managerSocket = socket;
      nextManagerMessage = messageQueue(socket);
      nextBinaryManagerMessage = binaryMessageQueue(socket);
      resolve(socket);
    });
  });
  const tunnel = new ManagerTunnel({
    serverUrl: `http://127.0.0.1:${managerPort}`,
    pairingCode: "pair-e2e",
    allowEnrollment: true,
    localOrigin: `http://127.0.0.1:${localPort}`,
    startupUrl: `http://127.0.0.1:${localPort}/?token=secret`,
    name: "e2e-plugin",
    instanceId: "default",
    maxProxyRequests: 1,
  });
  try {
    await tunnel.start();
    const socket = await managerConnected;
    const next = nextManagerMessage;
    const register = await next((value) => value.type === "register");
    assert.equal(
      register.instances[0].startupUrl.includes("token=secret"),
      true,
    );

    socket.send(
      JSON.stringify({
        type: "proxy_request",
        requestId: "bootstrap",
        method: "GET",
        path: "/",
        headers: {},
        bootstrap: true,
      }),
    );
    const bootstrap = await next((value) => value.requestId === "bootstrap");
    assert.equal(bootstrap.status, 303);
    assert.equal(bootstrap.headers.location, "/");
    assert.equal(bootstrap.setCookies[0].startsWith("dsh-auth-test=ok"), true);
    assert.equal(bootstrapTokenSeen, true);

    socket.send(
      JSON.stringify({
        type: "proxy_request",
        requestId: "clean",
        method: "GET",
        path: "/",
        headers: { Cookie: "dsh-auth-test=ok" },
      }),
    );
    const clean = await next((value) => value.requestId === "clean");
    assert.equal(clean.status, 200);
    assert.equal(clean.headers["content-encoding"], "gzip");
    assert.equal(
      gunzipSync(Buffer.from(clean.body, "base64")).toString(),
      "bootstrapped",
    );

    socket.send(
      JSON.stringify({
        type: "proxy_request",
        requestId: "binary",
        method: "GET",
        path: "/assets/test.js",
        headers: { Cookie: "dsh-auth-test=ok", "Accept-Encoding": "gzip" },
        binaryResponse: true,
      }),
    );
    const binary = await nextBinaryManagerMessage(
      (value) => value.requestId === "binary",
    );
    assert.equal(binary.type, "proxy_response_binary");
    assert.equal(binary.headers["content-encoding"], "gzip");
    assert.equal(gunzipSync(binary.bodyBytes).toString(), "binary-asset");

    socket.send(
      JSON.stringify({
        type: "proxy_request",
        requestId: "stream",
        method: "GET",
        path: "/stream",
        headers: {},
        streamResponse: true,
      }),
    );
    const streamStart = await next(
      (value) =>
        value.type === "proxy_response_start" && value.requestId === "stream",
    );
    assert.equal(streamStart.status, 200);
    const streamChunkA = await nextBinaryManagerMessage(
      (value) =>
        value.type === "proxy_response_chunk_binary" &&
        value.requestId === "stream",
    );
    const streamChunkB = await nextBinaryManagerMessage(
      (value) =>
        value.type === "proxy_response_chunk_binary" &&
        value.requestId === "stream",
    );
    assert.equal(
      Buffer.concat([streamChunkA.bodyBytes, streamChunkB.bodyBytes]).length,
      128 * 1024,
    );
    await next(
      (value) =>
        value.type === "proxy_response_end" && value.requestId === "stream",
    );

    socket.send(
      JSON.stringify({
        type: "proxy_request",
        requestId: "cancel-stream",
        method: "GET",
        path: "/slow",
        headers: {},
        streamResponse: true,
      }),
    );
    await next(
      (value) =>
        value.type === "proxy_response_start" &&
        value.requestId === "cancel-stream",
    );
    await nextBinaryManagerMessage(
      (value) =>
        value.type === "proxy_response_chunk_binary" &&
        value.requestId === "cancel-stream",
    );
    socket.send(
      JSON.stringify({
        type: "proxy_request",
        requestId: "concurrency-rejected",
        method: "GET",
        path: "/",
        headers: {},
      }),
    );
    const rejected = await next(
      (value) => value.requestId === "concurrency-rejected",
    );
    assert.equal(rejected.status, 503);
    socket.send(
      JSON.stringify({ type: "proxy_cancel", requestId: "cancel-stream" }),
    );
    await slowResponseClosedPromise;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(tunnel.activeHttpRequests.size, 0);
    assert.equal(tunnel.proxyMetrics.cancelled, 1);
    assert.equal(tunnel.proxyMetrics.rejected, 1);

    socket.send(
      JSON.stringify({
        type: "proxy_ws_open",
        requestId: "ws",
        path: "/api/remote.mux",
        headers: { Cookie: "dsh-auth-test=ok" },
        binaryFrames: true,
      }),
    );
    const opened = await next(
      (value) =>
        value.requestId === "ws" && value.type === "proxy_ws_open_result",
    );
    assert.equal(opened.ok, true);
    const frame = await nextBinaryManagerMessage(
      (value) =>
        value.requestId === "ws" && value.type === "proxy_ws_frame_binary",
    );
    assert.equal(frame.bodyBytes.toString(), "pong");
    assert.equal(websocketCookie, "dsh-auth-test=ok");
    socket.send(
      Buffer.concat([
        Buffer.from(
          JSON.stringify({
            type: "proxy_ws_frame_binary",
            requestId: "ws",
            frameType: "binary",
          }) + "\n",
        ),
        Buffer.from("ping"),
      ]),
    );
    const echoed = await nextBinaryManagerMessage(
      (value) =>
        value.requestId === "ws" && value.type === "proxy_ws_frame_binary",
    );
    assert.equal(echoed.frameType, "binary");
    assert.equal(echoed.bodyBytes.toString(), "ping");
    socket.send(JSON.stringify({ type: "proxy_ws_close", requestId: "ws" }));
  } finally {
    tunnel.close();
    managerSocket?.terminate();
    await closeWebSocketServer(managerWss);
    await closeServer(manager);
    await closeWebSocketServer(localWss);
    await closeServer(local);
  }
});
