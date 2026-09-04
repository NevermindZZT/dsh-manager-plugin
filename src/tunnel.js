import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import WebSocket from "ws";
import {
  enrollmentPayload,
  managerUrls,
  normalizeCapabilities,
  DEFAULT_CAPABILITIES,
} from "./protocol.js";
function fingerprint(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/[\s:.-]/g, "").toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(normalized))
    throw new Error(
      "manager TLS fingerprint must be empty or a 64-character SHA-256 value",
    );
  return normalized;
}
function tunnelClosedError() {
  const error = new Error("manager tunnel closed");
  error.code = "MANAGER_TUNNEL_CLOSED";
  return error;
}
function tlsAgent(expected) {
  const expectedFingerprint = fingerprint(expected);
  if (!expectedFingerprint) return undefined;
  // Certificate pinning intentionally replaces normal CA validation. The
  // public-CA path does not use this Agent and keeps Node's normal checks.
  // Note: https.Agent constructor options do not replace the prototype
  // createConnection, so assign the implementation on the instance.
  const agent = new https.Agent({ rejectUnauthorized: false });
  agent.createConnection = (options, callback) => {
    const { agent: _ignored, ...connectOptions } = options;
    const socket = tls.connect(connectOptions);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      callback?.(error || null, socket);
    };
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      if (fingerprint(certificate?.fingerprint256) !== expectedFingerprint) {
        const error = new Error("manager TLS fingerprint mismatch");
        socket.destroy(error);
        finish(error);
        return;
      }
      finish();
    });
    socket.once("error", finish);
    return socket;
  };
  return agent;
}
function requestJson(url, method, payload, token, expectedFingerprint) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const secure = url.protocol === "https:";
    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    if (token) options.headers.Authorization = "Bearer " + token;
    const pinnedFingerprint = fingerprint(expectedFingerprint);
    if (secure && pinnedFingerprint)
      options.agent = tlsAgent(pinnedFingerprint);
    const req = (secure ? https : http).request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let value = {};
        try {
          value = text ? JSON.parse(text) : {};
        } catch {
          value = { error: text };
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(
            value.error || "manager HTTP " + res.statusCode,
          );
          error.code = "MANAGER_HTTP_" + res.statusCode;
          error.statusCode = res.statusCode;
          return reject(error);
        }
        resolve(value);
      });
    });
    req.setTimeout(10000, () => {
      req.destroy(new Error("manager request timed out"));
    });
    req.on("error", reject);
    req.end(body);
  });
}
export class ManagerTunnel {
  constructor(options) {
    this.options = options;
    this.manager = managerUrls(options.serverUrl);
    const pinnedFingerprint = fingerprint(options.tlsFingerprint);
    console.info(
      "[dsh-manager-plugin] manager transport:",
      this.manager.base.href,
      pinnedFingerprint
        ? "tls=fingerprint"
        : this.manager.base.protocol === "https:"
          ? "tls=system-ca"
          : "tls=plain-http",
      "agentType=dsh-plugin",
    );
    this.capabilities = normalizeCapabilities(
      options.capabilities || DEFAULT_CAPABILITIES,
    );
    this.agentId = options.agentId || "";
    this.agentToken = options.agentToken || "";
    this.socket = null;
    this.closed = false;
    this.sockets = new Map();
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    this.pendingConnectReject = null;
    this.connecting = false;
  }
  async start() {
    if (this.connecting || this.closed) return;
    this.closed = false;
    this.connecting = true;
    try {
      if (!this.agentId || !this.agentToken) {
        if (this.options.allowEnrollment === false) {
          throw new Error(
            "manager Agent credentials are missing; enter a new pairing code to re-enroll",
          );
        }
        if (!String(this.options.pairingCode || "").trim()) {
          throw new Error(
            "manager Agent credentials are missing; configure a pairing code to enroll",
          );
        }
        await this.enroll();
      }
      if (this.closed) return;
      try {
        await this.connect();
      } catch (error) {
        if (error?.code !== "AGENT_AUTH_REJECTED") throw error;
        this.agentId = "";
        this.agentToken = "";
        this.options.onCredentialsRejected?.();
        if (this.closed) return;
        if (
          this.options.allowEnrollment === true &&
          String(this.options.pairingCode || "").trim()
        ) {
          console.info(
            "[dsh-manager-plugin] saved Agent credentials were rejected; enrolling with the newly entered pairing code",
          );
          await this.enroll();
          if (this.closed) return;
          await this.connect();
          return;
        }
        console.warn(
          "[dsh-manager-plugin] saved Agent credentials were rejected; waiting for a new pairing code",
        );
      }
    } finally {
      this.connecting = false;
    }
  }
  async enroll() {
    const result = await requestJson(
      this.manager.enroll,
      "POST",
      enrollmentPayload(this.options),
      "",
      this.options.tlsFingerprint,
    );
    this.agentId = result.agentId;
    this.agentToken = result.agentToken;
    if (!this.agentId || !this.agentToken)
      throw new Error("invalid manager enrollment response");
    this.options.onEnrollment?.({
      agentId: this.agentId,
      agentToken: this.agentToken,
    });
    // Keep the configured pairing code so a later re-enrollment can recover
    // after the manager database is replaced or the Agent is revoked.
  }
  connect() {
    return new Promise((resolve, reject) => {
      const wsOptions = {
        headers: {
          Authorization: "Bearer " + this.agentToken,
          "X-Agent-Id": this.agentId,
        },
      };
      const pinnedFingerprint = fingerprint(this.options.tlsFingerprint);
      if (this.manager.base.protocol === "https:" && pinnedFingerprint) {
        wsOptions.rejectUnauthorized = false;
        wsOptions.agent = tlsAgent(pinnedFingerprint);
      }
      const socket = new WebSocket(this.manager.connect, wsOptions);
      this.socket = socket;
      let settled = false;
      let opened = false;
      let authRejected = false;
      let keepaliveTimer = null;
      const settleReject = (error) => {
        if (settled) return;
        settled = true;
        if (this.pendingConnectReject === settleReject)
          this.pendingConnectReject = null;
        reject(error);
      };
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        if (this.pendingConnectReject === settleReject)
          this.pendingConnectReject = null;
        resolve();
      };
      this.pendingConnectReject = settleReject;
      socket.once("open", () => {
        if (this.closed) {
          settleReject(tunnelClosedError());
          return;
        }
        opened = true;
        this.reconnectDelay = 1000;
        keepaliveTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.ping();
        }, 20000);
        keepaliveTimer.unref?.();
        this.keepaliveTimer = keepaliveTimer;
        console.info(
          "[dsh-manager-plugin] sending register:",
          this.options.name || "dsh-plugin",
          this.options.instanceId || "default",
        );
        this.send({
          type: "register",
          name: this.options.name || "dsh-plugin",
          agentType: "dsh-plugin",
          agentVersion: process.version,
          pluginVersion: this.options.pluginVersion || "0.1.7",
          capabilities: this.capabilities,
          instances: [this.instance()],
        });
        settleResolve();
      });
      socket.on("message", (data) => this.handleMessage(data));
      socket.once("unexpected-response", (_request, response) => {
        const error = new Error(
          "manager WebSocket rejected: HTTP " + response.statusCode,
        );
        if (response.statusCode === 401 || response.statusCode === 403)
          error.code = "AGENT_AUTH_REJECTED";
        authRejected = error.code === "AGENT_AUTH_REJECTED";
        response.resume();
        if (this.closed) settleReject(tunnelClosedError());
        else settleReject(error);
      });
      socket.once("error", (error) => {
        if (this.closed) {
          settleReject(tunnelClosedError());
          return;
        }
        // ws can emit a second error after unexpected-response. It is already
        // represented by that HTTP status and must not become startup noise.
        if (!opened && settled) return;
        console.error("[dsh-manager-plugin] WebSocket error:", error.message);
        settleReject(error);
      });
      socket.once("close", () => {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        if (this.socket === socket) {
          this.socket = null;
          if (this.keepaliveTimer === keepaliveTimer)
            this.keepaliveTimer = null;
        }
        if (this.closed) {
          settleReject(tunnelClosedError());
          return;
        }
        if (!settled)
          settleReject(
            Object.assign(
              new Error(
                "manager WebSocket closed before connection established",
              ),
              { code: "MANAGER_CONNECT_CLOSED" },
            ),
          );
        if (authRejected) return;
        if (opened) console.warn("[dsh-manager-plugin] WebSocket closed");
        this.scheduleReconnect();
      });
    });
  }
  scheduleReconnect() {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(30000, delay * 2);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed)
        this.start().catch((error) =>
          console.error(
            "[dsh-manager-plugin] reconnect failed:",
            error.message,
          ),
        );
    }, delay);
    this.reconnectTimer.unref?.();
  }
  instance() {
    return {
      instanceId: this.options.instanceId || "default",
      displayName: this.options.name || "dsh-plugin",
      type: "plugin",
      state: "running",
      urlAvailable: true,
      persistenceMode: "host",
      generation: 1,
      eventSeq: 1,
    };
  }
  send(value) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(value));
  }
  async handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    if (message.type === "command")
      return this.send({
        type: "command_result",
        requestId: message.requestId,
        instanceId: message.instanceId,
        ok: false,
        error: "dsh-plugin does not support lifecycle commands",
      });
    if (message.type === "proxy_request") return this.proxyHttp(message);
    if (message.type === "proxy_ws_open") return this.openWebSocket(message);
    if (message.type === "proxy_ws_frame")
      return this.forwardWebSocketFrame(message);
    if (message.type === "proxy_ws_close") return this.closeWebSocket(message);
  }
  localUrl(path) {
    return new URL(
      String(path || "/").replace(/^\//, ""),
      this.options.localOrigin.endsWith("/")
        ? this.options.localOrigin
        : this.options.localOrigin + "/",
    );
  }
  async proxyHttp(message) {
    try {
      const target = this.localUrl(message.path);
      const headers = { ...(message.headers || {}) };
      console.info(
        "[dsh-manager-plugin] proxy request:",
        message.method || "GET",
        message.path,
      );
      delete headers.host;
      delete headers.connection;
      delete headers.upgrade;
      // Node fetch transparently decompresses responses. Ask dsh for plain
      // bytes so the browser never receives a stale Content-Encoding header.
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === "accept-encoding") delete headers[key];
      }
      headers["accept-encoding"] = "identity";
      const localOrigin = this.options.localOrigin.replace(/\/$/, "");
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower === "origin") headers[key] = localOrigin;
        else if (lower === "referer") headers[key] = localOrigin + "/";
      }
      const body = message.body
        ? Buffer.from(message.body, "base64")
        : undefined;
      const response = await fetch(target, {
        method: message.method || "GET",
        headers,
        body,
        redirect: "manual",
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      const resultHeaders = {};
      const setCookies = response.headers.getSetCookie?.() || [];
      response.headers.forEach((value, key) => {
        if (
          ![
            "connection",
            "transfer-encoding",
            "content-length",
            "content-encoding",
            "set-cookie",
          ].includes(key.toLowerCase())
        )
          resultHeaders[key] = value;
      });
      console.info(
        "[dsh-manager-plugin] proxy response:",
        message.method || "GET",
        message.path,
        response.status,
        bytes.length + " bytes",
        setCookies.length + " cookies",
      );
      this.send({
        type: "proxy_response",
        requestId: message.requestId,
        status: response.status,
        headers: resultHeaders,
        setCookies,
        body: bytes.toString("base64"),
      });
    } catch (error) {
      console.error(
        "[dsh-manager-plugin] proxy request failed:",
        message.method || "GET",
        message.path,
        error.message,
      );
      this.send({
        type: "proxy_response",
        requestId: message.requestId,
        status: 502,
        error: error.message,
      });
    }
  }
  openWebSocket(message) {
    try {
      const target = this.localUrl(message.path);
      target.protocol = "ws:";
      const socket = new WebSocket(target, {
        headers: {
          Origin: this.options.localOrigin,
          Referer: this.options.localOrigin + "/",
        },
      });
      this.sockets.set(message.requestId, socket);
      socket.on("open", () =>
        this.send({
          type: "proxy_ws_open_result",
          requestId: message.requestId,
          ok: true,
        }),
      );
      socket.on("message", (data, isBinary) =>
        this.send({
          type: "proxy_ws_frame",
          requestId: message.requestId,
          frameType: isBinary ? "binary" : "text",
          body: Buffer.from(data).toString("base64"),
        }),
      );
      socket.on("error", (error) =>
        this.send({
          type: "proxy_ws_close",
          requestId: message.requestId,
          error: error.message,
        }),
      );
      socket.on("close", () => {
        this.sockets.delete(message.requestId);
        this.send({
          type: "proxy_ws_close",
          requestId: message.requestId,
          error: "local dsh websocket closed",
        });
      });
    } catch (error) {
      this.send({
        type: "proxy_ws_open_result",
        requestId: message.requestId,
        ok: false,
        error: error.message,
      });
    }
  }
  forwardWebSocketFrame(message) {
    const socket = this.sockets.get(message.requestId);
    if (socket)
      socket.send(Buffer.from(message.body || "", "base64"), {
        binary: message.frameType === "binary",
      });
  }
  closeWebSocket(message) {
    const socket = this.sockets.get(message.requestId);
    if (socket) {
      socket.close();
      this.sockets.delete(message.requestId);
    }
  }
  close() {
    this.closed = true;
    for (const socket of this.sockets.values()) socket.close();
    this.sockets.clear();
    const rejectConnect = this.pendingConnectReject;
    this.pendingConnectReject = null;
    rejectConnect?.(tunnelClosedError());
    const socket = this.socket;
    this.socket = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    if (socket) {
      if (socket.readyState === WebSocket.CONNECTING) {
        // ws.terminate() can emit a late error for a CONNECTING socket. The
        // pending promise is already settled with an intentional-close code.
        socket.on("error", () => {});
        socket.terminate();
      } else if (socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    }
  }
}
