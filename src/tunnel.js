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
const maxStreamChunkBytes = 64 * 1024;
const defaultMaxProxyRequests = 16;
const defaultMaxBufferedResponseBytes = 32 * 1024 * 1024;
const defaultMaxStreamRequestBytes = 32 * 1024 * 1024;
const defaultMaxStreamRequestChunkBytes = 64 * 1024;
const defaultMaxBufferedStreamRequestBytes = 1024 * 1024;
const defaultMaxQueuedOutboundFrames = 256;
const defaultMaxQueuedOutboundBytes = 8 * 1024 * 1024;
const outboundPriorities = ["critical", "interactive", "bulk"];
// Weighted round-robin gives control frames low latency without starving
// response chunks when a manager is busy.
const outboundSchedule = [
  "critical",
  "critical",
  "critical",
  "interactive",
  "interactive",
  "bulk",
];
function outboundQueueFullError() {
  const error = new Error("manager outbound frame queue is full");
  error.code = "PROXY_OUTBOUND_QUEUE_FULL";
  return error;
}
function outboundPriority(value) {
  const type = value?.type || "";
  if (
    type === "proxy_response_start" ||
    type === "proxy_response_end" ||
    type === "proxy_ws_open_result" ||
    type === "proxy_ws_close" ||
    (type === "proxy_response" && value?.error)
  )
    return "critical";
  if (
    type === "proxy_response_chunk_binary" ||
    type === "proxy_ws_frame" ||
    type === "proxy_ws_frame_binary"
  )
    return "bulk";
  return "interactive";
}
function streamedRequestLimitError(limit) {
  const error = new Error(
    "manager streamed request exceeds limit of " + limit + " bytes",
  );
  error.code = "PROXY_REQUEST_TOO_LARGE";
  return error;
}
function bufferedResponseLimitError(limit) {
  const error = new Error(
    "local dsh response exceeds buffer limit of " + limit + " bytes",
  );
  error.code = "PROXY_RESPONSE_TOO_LARGE";
  return error;
}
function binaryEnvelope(value, body) {
  return Buffer.concat([
    Buffer.from(JSON.stringify(value) + "\n", "utf8"),
    Buffer.from(body),
  ]);
}
function parseBinaryEnvelope(raw) {
  const data = Buffer.from(raw);
  const separator = data.indexOf(10);
  if (separator <= 0) return null;
  try {
    return {
      ...JSON.parse(data.subarray(0, separator).toString("utf8")),
      bodyBytes: data.subarray(separator + 1),
    };
  } catch {
    return null;
  }
}
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
function safeLogPath(value) {
  try {
    const target = new URL(String(value || "/"), "http://dsh.local");
    return (
      target.pathname + (target.search || target.hash ? "?[REDACTED]" : "")
    );
  } catch {
    return "[invalid path]";
  }
}
function acceptsGzip(value) {
  return String(value || "")
    .split(",")
    .some(
      (item) => item.trim().split(";", 1)[0].trim().toLowerCase() === "gzip",
    );
}
function bufferHttpResponse(response, record) {
  return new Promise((resolve, reject) => {
    const limit = record.maxBufferedResponseBytes;
    const contentLength = Number(response.headers["content-length"]);
    response.on("error", reject);
    if (Number.isFinite(contentLength) && contentLength > limit) {
      const error = bufferedResponseLimitError(limit);
      response.destroy(error);
      reject(error);
      return;
    }
    let byteLength = 0;
    const chunks = [];
    response.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      if (byteLength + bytes.length > limit) {
        const error = bufferedResponseLimitError(limit);
        response.destroy(error);
        reject(error);
        return;
      }
      byteLength += bytes.length;
      chunks.push(bytes);
    });
    response.on("end", () =>
      resolve({
        status: response.statusCode || 502,
        headers: response.headers,
        body: Buffer.concat(chunks, byteLength),
      }),
    );
    response.on("aborted", () =>
      reject(new Error("local dsh response aborted")),
    );
  });
}
function requestRaw(url, method, headers, body, record) {
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
    const req = (secure ? https : http).request(options, (response) => {
      record.response = response;
      bufferHttpResponse(response, record).then(resolve, reject);
    });
    record.req = req;
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
      this.manager.base.origin,
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
    this.activeHttpRequests = new Map();
    this.maxProxyRequests =
      Number.isSafeInteger(options.maxProxyRequests) &&
      options.maxProxyRequests > 0
        ? options.maxProxyRequests
        : defaultMaxProxyRequests;
    this.maxBufferedResponseBytes =
      Number.isSafeInteger(options.maxBufferedResponseBytes) &&
      options.maxBufferedResponseBytes > 0
        ? options.maxBufferedResponseBytes
        : defaultMaxBufferedResponseBytes;
    this.proxyMetrics = {
      started: 0,
      completed: 0,
      cancelled: 0,
      failed: 0,
      rejected: 0,
      cancelMisses: 0,
      streamedBytes: 0,
      peakActive: 0,
      outboundEnqueued: 0,
      outboundSent: 0,
      outboundRejected: 0,
      outboundFailed: 0,
      outboundQueuedFrames: 0,
      outboundQueuedBytes: 0,
      outboundPeakQueuedFrames: 0,
      outboundPeakQueuedBytes: 0,
      streamedRequestBytes: 0,
      streamedRequestRejected: 0,
      streamedRequestPeakBufferedBytes: 0,
      outboundByPriority: Object.fromEntries(
        outboundPriorities.map((priority) => [
          priority,
          { enqueued: 0, sent: 0, rejected: 0 },
        ]),
      ),
    };
    this.maxStreamRequestBytes =
      Number.isSafeInteger(options.maxStreamRequestBytes) &&
      options.maxStreamRequestBytes > 0
        ? options.maxStreamRequestBytes
        : defaultMaxStreamRequestBytes;
    this.maxStreamRequestChunkBytes =
      Number.isSafeInteger(options.maxStreamRequestChunkBytes) &&
      options.maxStreamRequestChunkBytes > 0
        ? options.maxStreamRequestChunkBytes
        : defaultMaxStreamRequestChunkBytes;
    this.maxBufferedStreamRequestBytes =
      Number.isSafeInteger(options.maxBufferedStreamRequestBytes) &&
      options.maxBufferedStreamRequestBytes > 0
        ? options.maxBufferedStreamRequestBytes
        : defaultMaxBufferedStreamRequestBytes;
    this.maxQueuedOutboundFrames =
      Number.isSafeInteger(options.maxQueuedOutboundFrames) &&
      options.maxQueuedOutboundFrames > 0
        ? options.maxQueuedOutboundFrames
        : defaultMaxQueuedOutboundFrames;
    this.maxQueuedOutboundBytes =
      Number.isSafeInteger(options.maxQueuedOutboundBytes) &&
      options.maxQueuedOutboundBytes > 0
        ? options.maxQueuedOutboundBytes
        : defaultMaxQueuedOutboundBytes;
    this.outboundQueues = Object.fromEntries(
      outboundPriorities.map((priority) => [priority, []]),
    );
    this.outboundCursor = 0;
    this.outboundSending = false;
    this.outboundInFlight = null;
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
          pluginVersion: this.options.pluginVersion || "0.2.3",
          capabilities: this.capabilities,
          instances: [this.instance()],
        });
        settleResolve();
      });
      socket.on("message", (data, isBinary) =>
        this.handleMessage(data, isBinary),
      );
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
          this.failOutbound(tunnelClosedError());
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
  enqueueOutbound(payload, priority) {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(tunnelClosedError());
    const selected = outboundPriorities.includes(priority)
      ? priority
      : "interactive";
    const bytes = Buffer.byteLength(payload);
    const metrics = this.proxyMetrics;
    if (
      metrics.outboundQueuedFrames >= this.maxQueuedOutboundFrames ||
      metrics.outboundQueuedBytes + bytes > this.maxQueuedOutboundBytes
    ) {
      metrics.outboundRejected++;
      metrics.outboundByPriority[selected].rejected++;
      return Promise.reject(outboundQueueFullError());
    }
    return new Promise((resolve, reject) => {
      this.outboundQueues[selected].push({ payload, bytes, resolve, reject });
      metrics.outboundEnqueued++;
      metrics.outboundByPriority[selected].enqueued++;
      metrics.outboundQueuedFrames++;
      metrics.outboundQueuedBytes += bytes;
      metrics.outboundPeakQueuedFrames = Math.max(
        metrics.outboundPeakQueuedFrames,
        metrics.outboundQueuedFrames,
      );
      metrics.outboundPeakQueuedBytes = Math.max(
        metrics.outboundPeakQueuedBytes,
        metrics.outboundQueuedBytes,
      );
      this.drainOutbound();
    });
  }
  takeOutbound() {
    for (let offset = 0; offset < outboundSchedule.length; offset++) {
      const index = (this.outboundCursor + offset) % outboundSchedule.length;
      const priority = outboundSchedule[index];
      const queue = this.outboundQueues[priority];
      if (queue.length === 0) continue;
      this.outboundCursor = (index + 1) % outboundSchedule.length;
      const frame = queue.shift();
      this.proxyMetrics.outboundQueuedFrames--;
      this.proxyMetrics.outboundQueuedBytes -= frame.bytes;
      return { priority, frame };
    }
    return null;
  }
  drainOutbound() {
    if (this.outboundSending) return;
    const next = this.takeOutbound();
    if (!next) return;
    if (this.socket?.readyState !== WebSocket.OPEN) {
      next.frame.reject(tunnelClosedError());
      this.failOutbound(tunnelClosedError());
      return;
    }
    this.outboundSending = true;
    this.outboundInFlight = next.frame;
    const complete = (error) => {
      // A close can reject and clear an in-flight callback before ws invokes it.
      if (this.outboundInFlight !== next.frame) return;
      this.outboundSending = false;
      this.outboundInFlight = null;
      if (error) {
        this.proxyMetrics.outboundFailed++;
        next.frame.reject(error);
      } else {
        this.proxyMetrics.outboundSent++;
        this.proxyMetrics.outboundByPriority[next.priority].sent++;
        next.frame.resolve();
      }
      this.drainOutbound();
    };
    try {
      this.socket.send(next.frame.payload, complete);
    } catch (error) {
      complete(error);
    }
  }
  failOutbound(error = tunnelClosedError()) {
    if (this.outboundInFlight) {
      this.proxyMetrics.outboundFailed++;
      this.outboundInFlight.reject(error);
      this.outboundInFlight = null;
      this.outboundSending = false;
    }
    for (const priority of outboundPriorities) {
      const queue = this.outboundQueues[priority];
      while (queue.length) {
        const frame = queue.shift();
        this.proxyMetrics.outboundQueuedFrames--;
        this.proxyMetrics.outboundQueuedBytes -= frame.bytes;
        this.proxyMetrics.outboundFailed++;
        frame.reject(error);
      }
    }
  }
  sendAsync(value, body, priority = outboundPriority(value)) {
    const payload =
      body === undefined ? JSON.stringify(value) : binaryEnvelope(value, body);
    return this.enqueueOutbound(payload, priority);
  }
  sendBinary(value, body, priority = outboundPriority(value)) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    const payload = binaryEnvelope(
      { ...value, type: value.type || "proxy_response_binary" },
      body,
    );
    this.enqueueOutbound(payload, priority).catch((error) =>
      console.warn(
        "[dsh-manager-plugin] outbound frame dropped:",
        error.message,
      ),
    );
    return true;
  }
  async handleMessage(raw, isBinary = false) {
    const message = isBinary
      ? parseBinaryEnvelope(raw)
      : (() => {
          try {
            return JSON.parse(raw.toString("utf8"));
          } catch {
            return null;
          }
        })();
    if (!message) return;
    if (message.type === "command")
      return this.send({
        type: "command_result",
        requestId: message.requestId,
        instanceId: message.instanceId,
        ok: false,
        error: "dsh-plugin does not support lifecycle commands",
      });
    if (message.type === "proxy_cancel") return this.cancelHttp(message);
    if (message.type === "proxy_request") return this.proxyHttp(message);
    if (message.type === "proxy_request_start")
      return this.proxyHttpRequestStart(message);
    if (message.type === "proxy_request_chunk_binary")
      return this.proxyHttpRequestChunk(message, message.bodyBytes);
    if (message.type === "proxy_request_end")
      return this.proxyHttpRequestEnd(message);
    if (message.type === "proxy_ws_open") return this.openWebSocket(message);
    if (message.type === "proxy_ws_frame")
      return this.forwardWebSocketFrame(message);
    if (message.type === "proxy_ws_frame_binary")
      return this.forwardWebSocketFrame(message, message.bodyBytes);
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
  beginHttpRequest(message) {
    const requestId = message.requestId;
    if (!requestId || this.activeHttpRequests.has(requestId)) {
      this.proxyMetrics.rejected++;
      console.warn("[dsh-manager-plugin] proxy request rejected:", requestId);
      this.send({
        type: "proxy_response",
        requestId,
        status: 409,
        error: "duplicate or missing proxy request id",
      });
      return null;
    }
    if (this.activeHttpRequests.size >= this.maxProxyRequests) {
      this.proxyMetrics.rejected++;
      console.warn(
        "[dsh-manager-plugin] proxy concurrency limit:",
        requestId,
        "active=" + this.activeHttpRequests.size,
        "limit=" + this.maxProxyRequests,
      );
      this.send({
        type: "proxy_response",
        requestId,
        status: 503,
        error: "proxy concurrency limit exceeded",
      });
      return null;
    }
    const record = {
      requestId,
      req: null,
      response: null,
      startedAt: Date.now(),
      streaming: message.streamResponse === true,
      requestStreaming: false,
      upload: null,
      cancelled: false,
      responseStarted: false,
      responseEnded: false,
      bytes: 0,
      maxBufferedResponseBytes: this.maxBufferedResponseBytes,
      settled: false,
    };
    this.activeHttpRequests.set(requestId, record);
    this.proxyMetrics.started++;
    this.proxyMetrics.peakActive = Math.max(
      this.proxyMetrics.peakActive,
      this.activeHttpRequests.size,
    );
    return record;
  }
  finishHttpRequest(record, outcome, error) {
    if (record.settled) return;
    record.settled = true;
    if (this.activeHttpRequests.get(record.requestId) === record)
      this.activeHttpRequests.delete(record.requestId);
    if (outcome === "cancelled") this.proxyMetrics.cancelled++;
    else if (outcome === "failed") this.proxyMetrics.failed++;
    else this.proxyMetrics.completed++;
    this.proxyMetrics.streamedBytes += record.bytes;
    console.info(
      "[dsh-manager-plugin] proxy complete:",
      record.requestId,
      "outcome=" + outcome,
      "stream=" + record.streaming,
      "bytes=" + record.bytes,
      "elapsedMs=" + (Date.now() - record.startedAt),
      "active=" + this.activeHttpRequests.size,
      error ? "error=" + error.message : "",
    );
  }
  cancelHttp(message) {
    const record = this.activeHttpRequests.get(message.requestId);
    if (!record) {
      this.proxyMetrics.cancelMisses++;
      console.info(
        "[dsh-manager-plugin] proxy cancel miss:",
        message.requestId,
      );
      return;
    }
    if (record.cancelled) return;
    record.cancelled = true;
    const error = Object.assign(new Error("manager cancelled proxy request"), {
      code: "PROXY_CANCELLED",
    });
    record.upload?.pending.splice(0);
    if (record.upload) record.upload.pendingBytes = 0;
    record.req?.destroy(error);
    record.response?.destroy(error);
  }
  responseMetadata(message, response, type) {
    const headers = {};
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
      headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    return {
      type,
      requestId: message.requestId,
      status: response.statusCode || 502,
      headers,
      setCookies,
    };
  }
  async streamHttpResponse(message, response, record) {
    await this.sendAsync(
      this.responseMetadata(message, response, "proxy_response_start"),
    );
    record.responseStarted = true;
    for await (const chunk of response) {
      if (record.cancelled) break;
      const bytes = Buffer.from(chunk);
      for (
        let offset = 0;
        offset < bytes.length;
        offset += maxStreamChunkBytes
      ) {
        if (record.cancelled) break;
        const body = bytes.subarray(offset, offset + maxStreamChunkBytes);
        await this.sendAsync(
          {
            type: "proxy_response_chunk_binary",
            requestId: message.requestId,
          },
          body,
        );
        record.bytes += body.length;
      }
    }
    if (!record.cancelled) {
      await this.sendAsync({
        type: "proxy_response_end",
        requestId: message.requestId,
      });
      record.responseEnded = true;
    }
  }
  proxyHttpStream(target, method, headers, body, message, record) {
    return new Promise((resolve, reject) => {
      const secure = target.protocol === "https:";
      const req = (secure ? https : http).request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (secure ? 443 : 80),
          path: target.pathname + target.search,
          method,
          headers,
        },
        (response) => {
          record.response = response;
          this.streamHttpResponse(message, response, record).then(
            resolve,
            reject,
          );
        },
      );
      record.req = req;
      req.setTimeout(proxyRequestTimeoutMs, () =>
        req.destroy(new Error("local streamed dsh request timed out")),
      );
      req.on("error", reject);
      if (body.length > 0) req.write(body);
      req.end();
    });
  }
  sendBufferedHttpResponse(message, response) {
    const bytes = response.body;
    const headers = {};
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
      headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    const metadata = {
      type: "proxy_response",
      requestId: message.requestId,
      status: response.status,
      headers,
      setCookies,
    };
    if (message.binaryResponse === true)
      this.sendBinary({ ...metadata, type: "proxy_response_binary" }, bytes);
    else this.send({ ...metadata, body: bytes.toString("base64") });
  }
  failHttpProxy(message, record, error) {
    if (record.cancelled) return;
    console.error(
      "[dsh-manager-plugin] proxy request failed:",
      message.method || "GET",
      safeLogPath(message.path),
      error.message,
    );
    if (record.streaming) {
      if (!record.responseStarted)
        this.send({
          type: "proxy_response_start",
          requestId: message.requestId,
          status: 502,
          error: error.message,
        });
      if (!record.responseEnded)
        this.send({
          type: "proxy_response_end",
          requestId: message.requestId,
          error: error.message,
        });
    } else {
      this.send({
        type: "proxy_response",
        requestId: message.requestId,
        status: 502,
        error: error.message,
      });
    }
  }
  rejectStreamedRequest(record, error) {
    if (record.cancelled || record.upload?.rejected) return;
    record.upload.rejected = true;
    record.upload.pending = [];
    record.upload.pendingBytes = 0;
    this.proxyMetrics.streamedRequestRejected++;
    record.req?.destroy(error);
    record.response?.destroy(error);
  }
  flushStreamedRequest(record) {
    const upload = record.upload;
    if (!upload || upload.rejected || record.cancelled || upload.backpressured)
      return;
    while (upload.pending.length && !upload.backpressured) {
      const chunk = upload.pending.shift();
      upload.pendingBytes -= chunk.length;
      upload.backpressured = !record.req.write(chunk);
    }
    if (upload.ended && upload.pending.length === 0 && !upload.backpressured)
      record.req.end();
  }
  proxyHttpRequestChunk(message, bodyBytes) {
    const record = this.activeHttpRequests.get(message.requestId);
    const upload = record?.upload;
    if (
      !record?.requestStreaming ||
      !upload ||
      upload.ended ||
      upload.rejected
    ) {
      this.proxyMetrics.rejected++;
      return;
    }
    if (!bodyBytes) {
      this.rejectStreamedRequest(
        record,
        new Error("streamed request chunk must use a binary envelope"),
      );
      return;
    }
    const chunk = Buffer.from(bodyBytes);
    if (chunk.length > this.maxStreamRequestChunkBytes) {
      this.rejectStreamedRequest(
        record,
        streamedRequestLimitError(this.maxStreamRequestChunkBytes),
      );
      return;
    }
    if (upload.bytes + chunk.length > this.maxStreamRequestBytes) {
      this.rejectStreamedRequest(
        record,
        streamedRequestLimitError(this.maxStreamRequestBytes),
      );
      return;
    }
    upload.bytes += chunk.length;
    this.proxyMetrics.streamedRequestBytes += chunk.length;
    if (upload.backpressured) {
      if (
        upload.pendingBytes + chunk.length >
        this.maxBufferedStreamRequestBytes
      ) {
        this.rejectStreamedRequest(
          record,
          streamedRequestLimitError(this.maxBufferedStreamRequestBytes),
        );
        return;
      }
      upload.pending.push(chunk);
      upload.pendingBytes += chunk.length;
      this.proxyMetrics.streamedRequestPeakBufferedBytes = Math.max(
        this.proxyMetrics.streamedRequestPeakBufferedBytes,
        upload.pendingBytes,
      );
      return;
    }
    upload.backpressured = !record.req.write(chunk);
  }
  proxyHttpRequestEnd(message) {
    const record = this.activeHttpRequests.get(message.requestId);
    const upload = record?.upload;
    if (
      !record?.requestStreaming ||
      !upload ||
      upload.ended ||
      upload.rejected
    ) {
      this.proxyMetrics.rejected++;
      return;
    }
    if (
      Number.isSafeInteger(upload.contentLength) &&
      upload.bytes !== upload.contentLength
    ) {
      this.rejectStreamedRequest(
        record,
        new Error(
          "streamed request content length does not match received bytes",
        ),
      );
      return;
    }
    upload.ended = true;
    this.flushStreamedRequest(record);
  }
  async proxyHttpRequestStart(message) {
    const record = this.beginHttpRequest(message);
    if (!record) return;
    record.requestStreaming = true;
    record.upload = {
      bytes: 0,
      pending: [],
      pendingBytes: 0,
      backpressured: false,
      ended: false,
      rejected: false,
      contentLength: null,
    };
    let outcome = "completed";
    let failure;
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
      headers["accept-encoding"] = acceptsGzip(acceptedEncoding)
        ? "gzip"
        : "identity";
      const localOrigin = this.options.localOrigin.replace(/\/$/, "");
      for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower === "origin") headers[key] = localOrigin;
        else if (lower === "referer") headers[key] = localOrigin + "/";
      }
      const contentLength = Number(message.contentLength);
      if (Number.isSafeInteger(contentLength) && contentLength >= 0) {
        if (contentLength > this.maxStreamRequestBytes)
          throw streamedRequestLimitError(this.maxStreamRequestBytes);
        headers["content-length"] = String(contentLength);
        record.upload.contentLength = contentLength;
      }
      await new Promise((resolve, reject) => {
        const secure = target.protocol === "https:";
        const req = (secure ? https : http).request(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (secure ? 443 : 80),
            path: target.pathname + target.search,
            method: message.method || "GET",
            headers,
          },
          (response) => {
            record.response = response;
            const complete = record.streaming
              ? this.streamHttpResponse(message, response, record)
              : bufferHttpResponse(response, record).then((buffered) =>
                  this.sendBufferedHttpResponse(message, buffered),
                );
            complete.then(resolve, reject);
          },
        );
        record.req = req;
        req.setTimeout(proxyRequestTimeoutMs, () =>
          req.destroy(new Error("local streamed dsh request timed out")),
        );
        req.on("error", reject);
        req.on("drain", () => {
          if (!record.upload || record.cancelled) return;
          record.upload.backpressured = false;
          this.flushStreamedRequest(record);
        });
      });
    } catch (error) {
      failure = error;
      outcome = record.cancelled ? "cancelled" : "failed";
      this.failHttpProxy(message, record, error);
    } finally {
      if (record.cancelled) outcome = "cancelled";
      this.finishHttpRequest(record, outcome, failure);
    }
  }
  async proxyHttp(message) {
    const record = this.beginHttpRequest(message);
    if (!record) return;
    let outcome = "completed";
    let failure;
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
        safeLogPath(message.path),
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
      if (message.streamResponse === true) {
        await this.proxyHttpStream(
          target,
          message.method || "GET",
          headers,
          body,
          message,
          record,
        );
        return;
      }
      const response = await requestRaw(
        target,
        message.method || "GET",
        headers,
        body,
        record,
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
        safeLogPath(message.path),
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
        this.sendBinary({ ...metadata, type: "proxy_response_binary" }, bytes);
      } else {
        this.send({
          ...metadata,
          body: bytes.toString("base64"),
        });
      }
    } catch (error) {
      failure = error;
      outcome = record.cancelled ? "cancelled" : "failed";
      if (!record.cancelled) {
        console.error(
          "[dsh-manager-plugin] proxy request failed:",
          message.method || "GET",
          safeLogPath(message.path),
          error.message,
        );
        if (record.streaming) {
          if (!record.responseStarted)
            this.send({
              type: "proxy_response_start",
              requestId: message.requestId,
              status: 502,
              error: error.message,
            });
          if (!record.responseEnded)
            this.send({
              type: "proxy_response_end",
              requestId: message.requestId,
              error: error.message,
            });
        } else {
          this.send({
            type: "proxy_response",
            requestId: message.requestId,
            status: 502,
            error: error.message,
          });
        }
      }
    } finally {
      if (record.cancelled) outcome = "cancelled";
      this.finishHttpRequest(record, outcome, failure);
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
      socket.on("message", (data, isBinary) => {
        const body = Buffer.from(data);
        if (message.binaryFrames === true)
          this.sendBinary(
            {
              type: "proxy_ws_frame_binary",
              requestId: message.requestId,
              frameType: isBinary ? "binary" : "text",
            },
            body,
          );
        else
          this.send({
            type: "proxy_ws_frame",
            requestId: message.requestId,
            frameType: isBinary ? "binary" : "text",
            body: body.toString("base64"),
          });
      });
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
  forwardWebSocketFrame(message, bodyBytes) {
    const socket = this.sockets.get(message.requestId);
    if (socket)
      socket.send(bodyBytes || Buffer.from(message.body || "", "base64"), {
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
    this.failOutbound(tunnelClosedError());
    for (const socket of this.sockets.values()) socket.close();
    this.sockets.clear();
    for (const record of this.activeHttpRequests.values()) {
      record.cancelled = true;
      const error = Object.assign(new Error("manager tunnel closed"), {
        code: "MANAGER_TUNNEL_CLOSED",
      });
      record.req?.destroy(error);
      record.response?.destroy(error);
    }
    this.activeHttpRequests.clear();
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
