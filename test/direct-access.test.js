import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import {
  DirectAccessServer,
  validateDirectAccessOptions,
} from "../src/direct-access.js";

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
      server.closeAllConnections?.();
    } catch {
      resolve();
    }
  });
}

function closeWebSocketServer(server) {
  for (const socket of server.clients) socket.terminate();
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function requestWithHeaders(port, path, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function firstCookie(value) {
  assert.equal(typeof value, "string");
  return value.split(";", 1)[0];
}

test("non-loopback listeners allow optional passwords and protect configured secrets", () => {
  const localOrigin = "http://127.0.0.1:3080";
  const startupUrl = localOrigin + "/?token=startup-secret";
  const open = validateDirectAccessOptions({
    host: "0.0.0.0",
    port: 0,
    localOrigin,
    startupUrl,
  });
  assert.equal(open.password, "");
  assert.equal(open.passwordConfigured, false);
  assert.throws(
    () =>
      validateDirectAccessOptions({
        host: "0.0.0.0",
        port: 0,
        passwordConfigured: true,
        localOrigin,
        startupUrl,
      }),
    /configured direct access password is unavailable/i,
  );
  assert.throws(
    () =>
      validateDirectAccessOptions({
        host: "0.0.0.0",
        port: 0,
        password: "short",
        localOrigin,
        startupUrl,
      }),
    /at least 8 characters/i,
  );
  assert.equal(
    validateDirectAccessOptions({
      host: "0.0.0.0",
      port: 0,
      password: "12345678",
      localOrigin,
      startupUrl,
    }).password,
    "12345678",
  );
  assert.throws(
    () =>
      validateDirectAccessOptions({
        host: "127.0.0.1",
        port: 3081,
        localOrigin: "http://192.168.1.2:3080",
        startupUrl: "http://192.168.1.2:3080/?token=x",
      }),
    /loopback HTTP origin/i,
  );
});

test("direct HTTP proxy gates access, bootstraps DSH internally, and rewrites origin", async () => {
  let upstreamPort;
  let bootstrapSeen = false;
  let proxiedHost = "";
  let proxiedOrigin = "";
  let proxiedCookie = "";
  let uploadedBody = "";
  const upstream = http.createServer((request, response) => {
    if (request.url === "/?token=launch-secret") {
      bootstrapSeen = true;
      assert.equal(request.headers.host, "127.0.0.1:" + upstreamPort);
      response.writeHead(303, {
        Location: "/",
        "Set-Cookie": "dsh-auth-test=ready; Path=/; HttpOnly; SameSite=Strict",
      });
      response.end();
      return;
    }
    if (request.url === "/") {
      if (!request.headers.cookie?.includes("dsh-auth-test=ready")) {
        response.writeHead(401, { "Content-Type": "text/plain" });
        response.end("DSH auth required");
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<main>DSH Web</main>");
      return;
    }
    if (request.url === "/api/check") {
      proxiedHost = request.headers.host;
      proxiedOrigin = request.headers.origin || "";
      proxiedCookie = request.headers.cookie || "";
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/upload") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        uploadedBody = Buffer.concat(chunks).toString("utf8");
        response.writeHead(201, { "Content-Type": "text/plain" });
        response.end("uploaded");
      });
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  upstreamPort = await listen(upstream);
  const localOrigin = "http://127.0.0.1:" + upstreamPort;
  const localWss = new WebSocketServer({ noServer: true });
  let wsOrigin = "";
  let wsCookie = "";
  upstream.on("upgrade", (request, socket, head) => {
    if (request.url !== "/api/remote.mux") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    wsOrigin = request.headers.origin || "";
    wsCookie = request.headers.cookie || "";
    if (wsOrigin !== localOrigin || !wsCookie.includes("dsh-auth-test=ready")) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    localWss.handleUpgrade(request, socket, head, (websocket) => {
      localWss.emit("connection", websocket);
      websocket.on("message", (data, isBinary) =>
        websocket.send(data, { binary: isBinary }),
      );
    });
  });

  const direct = new DirectAccessServer({
    host: "127.0.0.1",
    port: 0,
    password: "trusted-lan-password",
    localOrigin,
    startupUrl: localOrigin + "/?token=launch-secret",
  });
  try {
    const { port } = await direct.start();
    const browserOrigin = "http://127.0.0.1:" + port;
    const unauthenticated = await fetch(browserOrigin + "/");
    assert.equal(unauthenticated.status, 401);
    assert.match(await unauthenticated.text(), /full DSH Web access/i);
    assert.equal(bootstrapSeen, false);

    const forgedOrigin = await fetch(browserOrigin + "/", {
      headers: { Origin: "http://attacker.invalid" },
    });
    assert.equal(forgedOrigin.status, 403);

    const forgedHost = await requestWithHeaders(port, "/", {
      Host: "attacker.invalid:" + port,
      Origin: "http://attacker.invalid:" + port,
    });
    assert.equal(forgedHost.status, 403);
    assert.equal(bootstrapSeen, false);

    const wrongPassword = await fetch(
      browserOrigin + "/.well-known/dsh-manager-plugin/direct-login",
      {
        method: "POST",
        redirect: "manual",
        headers: {
          Origin: browserOrigin,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ password: "wrong" }),
      },
    );
    assert.equal(wrongPassword.status, 401);
    assert.equal(bootstrapSeen, false);

    const login = await fetch(
      browserOrigin + "/.well-known/dsh-manager-plugin/direct-login",
      {
        method: "POST",
        redirect: "manual",
        headers: {
          Origin: browserOrigin,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ password: "trusted-lan-password" }),
      },
    );
    assert.equal(login.status, 303);
    const pluginCookie = firstCookie(login.headers.get("set-cookie"));
    assert.match(pluginCookie, /^dsh-manager-plugin-direct=/);

    const bootstrap = await fetch(browserOrigin + "/", {
      redirect: "manual",
      headers: { Cookie: pluginCookie },
    });
    assert.equal(bootstrap.status, 303);
    assert.equal(bootstrapSeen, true);
    assert.equal(bootstrap.headers.get("location"), browserOrigin + "/");
    assert.equal(
      bootstrap.headers.get("location").includes("launch-secret"),
      false,
    );
    const dshCookie = firstCookie(bootstrap.headers.get("set-cookie"));
    assert.equal(dshCookie, "dsh-auth-test=ready");

    const page = await fetch(browserOrigin + "/", {
      headers: { Cookie: pluginCookie + "; " + dshCookie },
    });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /DSH Web/);

    const api = await fetch(browserOrigin + "/api/check", {
      headers: {
        Cookie: pluginCookie + "; " + dshCookie,
        Origin: browserOrigin,
      },
    });
    assert.equal(api.status, 200);
    assert.equal(proxiedHost, "127.0.0.1:" + upstreamPort);
    assert.equal(proxiedOrigin, localOrigin);
    assert.equal(proxiedCookie, dshCookie);

    const upload = await fetch(browserOrigin + "/upload", {
      method: "POST",
      headers: {
        Cookie: pluginCookie + "; " + dshCookie,
        Origin: browserOrigin,
        "Content-Type": "application/octet-stream",
      },
      body: "streamed-file-content",
    });
    assert.equal(upload.status, 201);
    assert.equal(uploadedBody, "streamed-file-content");

    const externalSocket = new WebSocket(
      browserOrigin.replace("http:", "ws:") + "/api/remote.mux",
      {
        headers: {
          Cookie: pluginCookie + "; " + dshCookie,
          Origin: browserOrigin,
        },
      },
    );
    const echoed = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("WebSocket timed out")),
        3000,
      );
      externalSocket.once("open", () => externalSocket.send("ping"));
      externalSocket.once("message", (data) => {
        clearTimeout(timer);
        resolve(data.toString());
      });
      externalSocket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    assert.equal(echoed, "ping");
    assert.equal(wsOrigin, localOrigin);
    assert.equal(wsCookie, dshCookie);
    externalSocket.terminate();
  } finally {
    await direct.close();
    for (const socket of localWss.clients) socket.terminate();
    await closeWebSocketServer(localWss);
    await closeServer(upstream);
  }
});

test("closing while the direct listener is binding leaves no port open", async () => {
  const localOrigin = "http://127.0.0.1:3080";
  const direct = new DirectAccessServer({
    host: "127.0.0.1",
    port: 0,
    localOrigin,
    startupUrl: localOrigin + "/?token=bootstrap",
  });
  const starting = direct.start();
  await direct.close();
  await assert.rejects(starting, /closed while starting/i);
  assert.equal(direct.server.listening, false);
});
