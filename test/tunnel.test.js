import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
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

test("DSH startup bootstrap and authenticated WebSocket Cookie pass through the plugin", async () => {
  let bootstrapTokenSeen = false;
  let websocketCookie = "";
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
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("bootstrapped");
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
  const managerConnected = new Promise((resolve) => {
    managerWss.once("connection", (socket) => {
      managerSocket = socket;
      nextManagerMessage = messageQueue(socket);
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
    assert.equal(Buffer.from(clean.body, "base64").toString(), "bootstrapped");

    socket.send(
      JSON.stringify({
        type: "proxy_ws_open",
        requestId: "ws",
        path: "/api/remote.mux",
        headers: { Cookie: "dsh-auth-test=ok" },
      }),
    );
    const opened = await next(
      (value) =>
        value.requestId === "ws" && value.type === "proxy_ws_open_result",
    );
    assert.equal(opened.ok, true);
    const frame = await next(
      (value) => value.requestId === "ws" && value.type === "proxy_ws_frame",
    );
    assert.equal(Buffer.from(frame.body, "base64").toString(), "pong");
    assert.equal(websocketCookie, "dsh-auth-test=ok");
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
