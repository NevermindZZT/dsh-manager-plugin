import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { ManagerTunnel } from "../src/tunnel.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function rejectUpgrade(socket, status = 401) {
  socket.end(
    "HTTP/1.1 " + status + " Unauthorized\r\n" +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n\r\n",
  );
}

test("rejected saved credentials wait for a new pairing code", async () => {
  let enrollmentRequests = 0;
  let rejectedConnections = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/api/v1/agents/enroll") enrollmentRequests++;
    response.writeHead(404);
    response.end();
  });
  server.on("upgrade", (_request, socket) => {
    rejectedConnections++;
    rejectUpgrade(socket);
  });
  const port = await listen(server);
  const tunnel = new ManagerTunnel({
    serverUrl: "http://127.0.0.1:" + port,
    agentId: "agent-old",
    agentToken: "token-old",
    pairingCode: "stale-code",
    allowEnrollment: false,
    localOrigin: "http://127.0.0.1:1",
  });

  try {
    await tunnel.start();
    assert.equal(rejectedConnections, 1);
    assert.equal(enrollmentRequests, 0);
    assert.equal(tunnel.agentId, "");
    assert.equal(tunnel.agentToken, "");
  } finally {
    tunnel.close();
    await closeServer(server);
  }
});

test("a changed pairing code does not replace valid Agent credentials", async () => {
  let enrollmentRequests = 0;
  const seenHeaders = [];
  const server = http.createServer((request, response) => {
    if (request.url === "/api/v1/agents/enroll") enrollmentRequests++;
    response.writeHead(404);
    response.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    seenHeaders.push(request.headers);
    wss.handleUpgrade(request, socket, head, (websocket) => {
      wss.emit("connection", websocket, request);
    });
  });
  const port = await listen(server);
  const tunnel = new ManagerTunnel({
    serverUrl: "http://127.0.0.1:" + port,
    agentId: "agent-existing",
    agentToken: "token-existing",
    pairingCode: "fresh-manager-code",
    allowEnrollment: true,
    localOrigin: "http://127.0.0.1:1",
  });

  try {
    await tunnel.start();
    assert.equal(enrollmentRequests, 0);
    assert.equal(seenHeaders.length, 1);
    assert.equal(seenHeaders[0].authorization, "Bearer token-existing");
    assert.equal(seenHeaders[0]["x-agent-id"], "agent-existing");
  } finally {
    tunnel.close();
    for (const websocket of wss.clients) websocket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await closeServer(server);
  }
});
