import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { WebSocket, WebSocketServer } from "ws";
const sourceRoot = process.env.DSH_MANAGER_PLUGIN_TEST_ROOT
  ? pathToFileURL(
      path.resolve(process.env.DSH_MANAGER_PLUGIN_TEST_ROOT) + "/src/",
    )
  : new URL("../src/", import.meta.url);
const { apply, applyManagerAgent, inject, name } = await import(
  new URL("index.js", sourceRoot)
);
const { DirectAccessServer } = await import(
  new URL("direct-access.js", sourceRoot)
);
const { ManagerTunnel } = await import(new URL("tunnel.js", sourceRoot));

const rootDirectory = fileURLToPath(new URL("..", import.meta.url));
const settingsEvent = "settings/document-updated";

async function waitFor(predicate, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("Timed out waiting for " + description);
}

async function bind(port = 0) {
  const server = net.createServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function closeListener(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function harness(user = {}) {
  const ctx = new Context();
  let revision = 1;
  ctx.provide("webServer", { port: 18080 });
  ctx.provide("connection", {
    authenticatedUrl: (origin) => origin + "/?token=lifecycle-test",
  });
  ctx.provide("settings", {
    describe: () => [{ ns: name, revision, user }],
  });
  return {
    ctx,
    update(patch) {
      Object.assign(user, patch);
      ctx.emit(settingsEvent, name, ++revision);
    },
    listeners: () => ctx.events._hooks[settingsEvent]?.length || 0,
  };
}

// These are real transport/listener instances. Only observation is patched;
// Cordis, sockets, timers, startup, and close implementation remain real.
function observeResources(t) {
  const tunnels = [];
  const servers = [];
  const closes = new Map();
  for (const [Type, instances] of [
    [ManagerTunnel, tunnels],
    [DirectAccessServer, servers],
  ]) {
    const start = Type.prototype.start;
    const close = Type.prototype.close;
    Type.prototype.start = function (...args) {
      if (!instances.includes(this)) instances.push(this);
      return start.apply(this, args);
    };
    Type.prototype.close = function (...args) {
      closes.set(this, (closes.get(this) || 0) + 1);
      return close.apply(this, args);
    };
    t.after(() => {
      Type.prototype.start = start;
      Type.prototype.close = close;
    });
  }
  t.after(async () => {
    // Failure safety only: all lifecycle assertions run before this fallback.
    await Promise.all([...tunnels, ...servers].map((value) => value.close()));
  });
  return { tunnels, servers, closes };
}

for (const discardReturn of [false, true]) {
  test(`real Cordis hot reload releases resources (${discardReturn ? "entry wrapper discards return" : "exported apply"})`, async (t) => {
    const directory = fs.mkdtempSync(
      path.join(rootDirectory, ".lifecycle-test-"),
    );
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const resources = observeResources(t);
    const manager = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(manager, "listening");
    let connections = 0;
    manager.on("connection", () => connections++);
    t.after(async () => {
      for (const socket of manager.clients) socket.terminate();
      await new Promise((resolve) => manager.close(resolve));
    });
    const reservation = await bind();
    const port = reservation.address().port;
    await closeListener(reservation);
    const config = {
      statePath: path.join(directory, "state.json"),
      serverUrl: "http://127.0.0.1:" + manager.address().port,
      agentId: "test-agent",
      agentToken: "test-token",
      directAccessEnabled: true,
      directAccessPort: port,
      onError: (error) => assert.fail(error.message),
    };
    const { ctx, update, listeners } = harness();
    t.after(() => ctx.fiber.dispose());
    const plugin = {
      name,
      inject,
      apply: discardReturn
        ? (ctx, config) => {
            // Reproduce an entry adapter that does not forward apply's result.
            apply(ctx, config);
          }
        : apply,
    };
    const fiber = await ctx.plugin(plugin, config);
    assert.ok(
      fiber
        .getEffects()
        .some((effect) => effect.label === "dsh-manager-plugin resources"),
      "cleanup must be explicitly owned, not just returned from apply",
    );
    for (let generation = 0; generation < 3; generation++) {
      await waitFor(
        () =>
          resources.tunnels.length === generation + 1 &&
          resources.servers.length === generation + 1 &&
          resources.servers[generation].started &&
          resources.tunnels[generation].socket?.readyState === WebSocket.OPEN,
        "generation " + generation,
      );
      assert.equal(listeners(), 1);
      const tunnel = resources.tunnels[generation];
      const server = resources.servers[generation];
      let reconnectTimer;
      if (generation === 0) {
        tunnel.socket.terminate();
        await waitFor(() => tunnel.reconnectTimer, "pending reconnect timer");
        reconnectTimer = tunnel.reconnectTimer;
      }
      if (generation < 2) await fiber.restart();
      else await fiber.dispose();
      assert.equal(tunnel.closed, true);
      assert.equal(tunnel.socket, null);
      assert.equal(tunnel.reconnectTimer, null);
      assert.equal(tunnel.keepaliveTimer, null);
      if (reconnectTimer) assert.equal(reconnectTimer._destroyed, true);
      assert.equal(server.server.listening, false);
      assert.equal(server.started, false);
      assert.equal(resources.closes.get(tunnel), 1);
      assert.equal(resources.closes.get(server), 1);
    }
    assert.equal(
      listeners(),
      0,
      "Settings listener is removed with child Fiber",
    );
    const rebound = await bind(port);
    await closeListener(rebound);
    const before = connections;
    update({ name: "must-not-restart-after-unload" });
    await delay(1100);
    assert.equal(connections, before, "no reconnect after unload");
    assert.equal(resources.tunnels.length, 3);
    assert.equal(resources.servers.length, 3);
  });
}

test("Cordis disposal awaits an old listener hidden by a Settings replacement", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(rootDirectory, ".lifecycle-test-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const servers = [];
  let releaseClose;
  const closeGate = new Promise((resolve) => (releaseClose = resolve));
  t.after(releaseClose);
  class SlowCloseServer extends DirectAccessServer {
    constructor(options) {
      super(options);
      this.closeCalls = 0;
      servers.push(this);
    }
    async close() {
      this.closeCalls++;
      await closeGate;
      await super.close();
    }
  }
  const { ctx, update, listeners } = harness();
  t.after(() => ctx.fiber.dispose());
  const fiber = await ctx.plugin((ctx) => {
    ctx.effect(() =>
      applyManagerAgent(
        ctx,
        {
          statePath: path.join(directory, "state.json"),
          enabled: false,
          directAccessEnabled: true,
          directAccessPort: 0,
        },
        ManagerTunnel,
        {},
        SlowCloseServer,
      ),
    );
  });
  await waitFor(() => servers[0]?.started, "initial direct listener");
  const port = servers[0].port;
  update({ directAccessPort: port, directAccessPassword: "changed-password" });
  await waitFor(() => servers[0].closeCalls === 1, "replacement close starts");
  update({ directAccessPassword: "another-password" });
  await delay(20);
  assert.equal(servers.length, 1, "new generation waits for old close");
  let settled = false;
  const disposing = fiber.dispose().then(() => (settled = true));
  await delay(20);
  assert.equal(
    settled,
    false,
    "unload must await the hidden previous listener",
  );
  releaseClose();
  await disposing;
  assert.equal(
    servers.length,
    1,
    "queued generations cannot start after disposal",
  );
  assert.equal(servers[0].closeCalls, 1);
  assert.equal(listeners(), 0);
  const rebound = await bind(port);
  await closeListener(rebound);
});

test("helper cleanup is joinable and closes a startup race exactly once", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(rootDirectory, ".lifecycle-test-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let releaseStart;
  const startGate = new Promise((resolve) => (releaseStart = resolve));
  const servers = [];
  class StartingServer {
    constructor() {
      this.closeCalls = 0;
      servers.push(this);
    }
    start() {
      return startGate;
    }
    async close() {
      this.closeCalls++;
      releaseStart();
      await delay(10);
    }
  }
  const { ctx } = harness();
  t.after(() => ctx.fiber.dispose());
  let cleanup;
  const fiber = await ctx.plugin((ctx) => {
    ctx.effect(() => {
      cleanup = applyManagerAgent(
        ctx,
        {
          statePath: path.join(directory, "state.json"),
          directAccessEnabled: true,
        },
        ManagerTunnel,
        {},
        StartingServer,
      );
      return cleanup;
    });
  });
  await waitFor(() => servers.length, "in-flight start");
  const first = cleanup();
  assert.equal(cleanup(), first, "manual helper callers join the same promise");
  // The actual owner must also await cleanup started by another caller.
  await fiber.dispose();
  await first;
  assert.equal(servers[0].closeCalls, 1);
});
