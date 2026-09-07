import http from "node:http";
import https from "node:https";
import WebSocket from "ws";
import {
  enrollmentPayload,
  managerUrls,
  normalizeCapabilities,
  DEFAULT_CAPABILITIES,
} from "./protocol.js";
function tunnelClosedError() {
  const error = new Error("manager tunnel closed");
  error.code = "MANAGER_TUNNEL_CLOSED";
  return error;
}
const proxyRequestTimeoutMs = 5 * 60 * 1000;
function deleteHeader(headers, name) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  }
}
function headerValue(headers, name) {
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === name.toLowerCase()) return String(value || "");
  }
  return "";
}
function acceptsGzip(value) {
  return String(value || "")
    .split(",")
    .some(
      (item) => item.trim().split(";", 1)[0].trim().toLowerCase() === "gzip",
    );
}
function requestRaw(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
    };
    const req = (secure ? https : http).request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode || 502,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
      res.on("aborted", () => reject(new Error("local dsh response aborted")));
    });
    req.setTimeout(proxyRequestTimeoutMs, () => {
      req.destroy(new Error("local dsh request timed out"));
    });
    req.on("error", reject);
    if (body && body.length > 0) req.write(body);
    req.end();
  });
}
function requestJson(url, method, payload, token) {
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
    console.info(
      "[dsh-manager-plugin] manager transport:",
      this.manager.base.href,
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
          pluginVersion: this.options.pluginVersion || "0.2.2",
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
      startupUrl: this.options.startupUrl || undefined,
    };
  }
  send(value) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(value));
  }
  sendBinary(value, body) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const header = Buffer.from(
      JSON.stringify({ ...value, type: "proxy_response_binary" }) + "\n",
      "utf8",
    );
    this.socket.send(Buffer.concat([header, body]));
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
      const bootstrap =
        message.bootstrap === true &&
        (message.method || "GET") === "GET" &&
        message.path === "/" &&
        typeof this.options.startupUrl === "string";
      const target = bootstrap
        ? new URL(this.options.startupUrl)
        : this.localUrl(message.path);
      const headers = { ...(message.headers || {}) };
      console.info(
        "[dsh-manager-plugin] proxy request:",
        message.method || "GET",
        message.path,
      );
      deleteHeader(headers, "host");
      deleteHeader(headers, "connection");
      deleteHeader(headers, "upgrade");
      deleteHeader(headers, "content-length");
      deleteHeader(headers, "transfer-encoding");
      deleteHeader(headers, "content-encoding");
      deleteHeader(headers, "X-Dsh-Manager-Bootstrap");
      deleteHeader(headers, "X-Dsh-Manager-Session");
      const acceptedEncoding = headerValue(message.headers, "accept-encoding");
      deleteHeader(headers, "accept-encoding");
      // DSH currently serves gzip. Use the raw node:http response path below so
      // compressed bytes and Set-Cookie headers survive the Agent tunnel.
      headers["accept-encoding"] = acceptsGzip(acceptedEncoding)
        ? "gzip"
        : "identity";
      const localOrigin = this.options.localOrigin.replace(/\/$/, "");
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower === "origin") headers[key] = localOrigin;
        else if (lower === "referer") headers[key] = localOrigin + "/";
      }
      const body = message.body
        ? Buffer.from(message.body, "base64")
        : Buffer.alloc(0);
      if (body.length > 0) headers["content-length"] = String(body.length);
      const response = await requestRaw(
        target,
        message.method || "GET",
        headers,
        body,
      );
      const bytes = response.body;
      const resultHeaders = {};
      const setCookies = Array.isArray(response.headers["set-cookie"])
        ? response.headers["set-cookie"]
        : [];
      for (const [key, value] of Object.entries(response.headers)) {
        if (
          value === undefined ||
          [
            "connection",
            "transfer-encoding",
            "content-length",
            "set-cookie",
          ].includes(key.toLowerCase())
        )
          continue;
        resultHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
      }
      console.info(
        "[dsh-manager-plugin] proxy response:",
        message.method || "GET",
        message.path,
        response.status,
        bytes.length + " bytes",
        response.headers["content-encoding"] || "identity",
        setCookies.length + " cookies",
      );
      const metadata = {
        type: "proxy_response",
        requestId: message.requestId,
        status: response.status,
        headers: resultHeaders,
        setCookies,
      };
      if (message.binaryResponse === true) {
        this.sendBinary(metadata, bytes);
      } else {
        this.send({
          ...metadata,
          body: bytes.toString("base64"),
        });
      }
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
          ...(message.headers?.Cookie
            ? { Cookie: message.headers.Cookie }
            : {}),
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
