import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { shouldAllowEnrollment } from "../src/protocol.js";
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

const fixtures = new URL("./fixtures/", import.meta.url);
const tlsKey = fs.readFileSync(fileURLToPath(new URL("server.key", fixtures)));
const tlsCert = fs.readFileSync(fileURLToPath(new URL("server.crt", fixtures)));
const tlsFingerprint = crypto
  .createHash("sha256")
  .update(new crypto.X509Certificate(tlsCert).raw)
  .digest("hex")
  .toUpperCase();

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

function tlsFixture() {
  const server = https.createServer({ key: tlsKey, cert: tlsCert }, (_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (websocket) => {
      wss.emit("connection", websocket, request);
    });
  });
  return { server, wss };
}

test("HTTPS with a matching fingerprint connects and registers", async () => {
  const { server, wss } = tlsFixture();
  let connections = 0;
  wss.on("connection", () => connections++);
  const port = await listen(server);
  const tunnel = new ManagerTunnel({
    serverUrl: "https://127.0.0.1:" + port,
    agentId: "agent-pinned",
    agentToken: "token-pinned",
    tlsFingerprint: tlsFingerprint,
    localOrigin: "http://127.0.0.1:1",
  });

  try {
    await tunnel.start();
    assert.equal(connections, 1);
  } finally {
    tunnel.close();
    for (const websocket of wss.clients) websocket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await closeServer(server);
  }
});

test("HTTPS with a mismatched fingerprint fails", async () => {
  const { server, wss } = tlsFixture();
  const port = await listen(server);
  const tunnel = new ManagerTunnel({
    serverUrl: "https://127.0.0.1:" + port,
    agentId: "agent-pinned",
    agentToken: "token-pinned",
    tlsFingerprint: "0".repeat(63) + "1",
    localOrigin: "http://127.0.0.1:1",
  });

  try {
    await assert.rejects(() => tunnel.start(), /fingerprint mismatch/);
  } finally {
    tunnel.close();
    for (const websocket of wss.clients) websocket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await closeServer(server);
  }
});

test("HTTPS with no fingerprint rejects a self-signed certificate", async () => {
  const { server, wss } = tlsFixture();
  const port = await listen(server);
  const tunnel = new ManagerTunnel({
    serverUrl: "https://127.0.0.1:" + port,
    agentId: "agent-pinned",
    agentToken: "token-pinned",
    tlsFingerprint: "",
    localOrigin: "http://127.0.0.1:1",
  });

  try {
    await assert.rejects(
      () => tunnel.start(),
      /self.signed|unable to verify|certificate/i,
    );
  } finally {
    tunnel.close();
    for (const websocket of wss.clients) websocket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await closeServer(server);
  }
});

test("first enrollment is allowed when credentials are absent", () => {
  assert.equal(
    shouldAllowEnrollment({
      agentId: "",
      agentToken: "",
      pairingCode: "current-code",
      pairingChanged: false,
      managerChanged: false,
    }),
    true,
  );
  assert.equal(
    shouldAllowEnrollment({
      agentId: "agent-existing",
      agentToken: "token-existing",
      pairingCode: "current-code",
      pairingChanged: false,
      managerChanged: false,
    }),
    false,
  );
  assert.equal(
    shouldAllowEnrollment({
      agentId: "",
      agentToken: "",
      pairingCode: "",
      pairingChanged: false,
      managerChanged: false,
    }),
    false,
  );
});

test("fingerprint rejects malformed values", () => {
  // fingerprint() is module-private, so exercise it through ManagerTunnel
  // construction: a malformed pin must throw a clear error.
  assert.throws(
    () =>
      new ManagerTunnel({
        serverUrl: "https://example.com",
        tlsFingerprint: "not-a-fingerprint",
      }),
    /64-character SHA-256/,
  );
  assert.throws(
    () =>
      new ManagerTunnel({
        serverUrl: "https://example.com",
        tlsFingerprint: "AB".repeat(31),
      }),
    /64-character SHA-256/,
  );
});
