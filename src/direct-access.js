import http from "node:http";
import net from "node:net";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

const directCookieName = "dsh-manager-plugin-direct";
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const maxLoginBodyBytes = 8 * 1024;
const maxLoginAttempts = 8;
const loginWindowMs = 60 * 1000;
const websocketHandshakeTimeoutMs = 15 * 1000;
const maxWebSocketPayload = 32 << 20;
const maxBufferedWebSocketBytes = 8 << 20;
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const loginPath = "/.well-known/dsh-manager-plugin/direct-login";
const logoutPath = "/.well-known/dsh-manager-plugin/direct-logout";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeAddress(value) {
  let address = String(value || "").toLowerCase();
  if (address.startsWith("::ffff:")) address = address.slice(7);
  if (address.includes("%")) address = address.slice(0, address.indexOf("%"));
  return address;
}

export function isLoopbackAddress(value) {
  const address = normalizeAddress(value);
  if (address === "localhost" || address === "::1") return true;
  if (net.isIPv4(address)) return address.startsWith("127.");
  if (net.isIPv6(address)) return address.startsWith("::ffff:127.");
  return false;
}

function normalizeHostname(value) {
  return String(value || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
}

function parseAuthority(value) {
  if (typeof value !== "string" || value.trim() !== value || value === "")
    return null;
  try {
    const url = new URL("http://" + value);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return {
      hostname: normalizeHostname(url.hostname),
      port: Number(url.port || 80),
      authority: url.host.toLowerCase(),
    };
  } catch {
    return null;
  }
}

function isValidListenAddress(address) {
  // Bind only numeric addresses so a DNS name cannot resolve outside loopback
  // after the password policy has classified it.
  return net.isIP(address) !== 0;
}

export function validateDirectAccessOptions(options = {}) {
  const host = String(options.host || "127.0.0.1").trim();
  const port = Number(options.port ?? 3081);
  const password = String(options.password || "");
  const passwordConfigured = options.passwordConfigured ?? password.length > 0;
  if (Buffer.byteLength(password, "utf8") > 1024)
    throw new Error("Direct access password is too long");
  if (!isValidListenAddress(host))
    throw new Error("Direct access listen address must be an IP literal");
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Direct access port must be an integer from 0 to 65535");
  if (passwordConfigured && password.length === 0)
    throw new Error("A configured direct access password is unavailable");
  if (password.length > 0 && password.length < 8)
    throw new Error(
      "The direct access password must contain at least 8 characters",
    );
  const upstream = new URL(String(options.localOrigin || ""));
  if (
    upstream.protocol !== "http:" ||
    !isLoopbackAddress(upstream.hostname) ||
    !Number.isInteger(Number(upstream.port))
  )
    throw new Error("Direct access upstream must be a loopback HTTP origin");
  if (port !== 0 && port === Number(upstream.port))
    throw new Error("Direct access port must differ from the DSH Web port");
  if (typeof options.startupUrl !== "string" || options.startupUrl === "")
    throw new Error("Direct access requires the DSH startup URL");
  const startup = new URL(options.startupUrl);
  if (
    startup.protocol !== "http:" ||
    startup.host !== upstream.host ||
    startup.pathname !== "/" ||
    !startup.searchParams.has("token")
  )
    throw new Error(
      "Direct access startup URL must be the authenticated DSH root URL",
    );
  return { host, port, password, passwordConfigured, upstream };
}

function parseRequestTarget(requestUrl) {
  if (typeof requestUrl !== "string" || requestUrl === "") return null;
  try {
    const base = new URL("http://direct.invalid");
    const url = new URL(requestUrl, base);
    if (url.origin !== base.origin || url.username || url.password || url.hash)
      return null;
    if (url.searchParams.has("token")) return null;
    return url;
  } catch {
    return null;
  }
}

function frameByteLength(data) {
  if (Array.isArray(data))
    return data.reduce((total, chunk) => total + chunk.length, 0);
  return Number(data?.byteLength ?? data?.length ?? 0);
}

function cookiesFromHeader(value) {
  const result = [];
  for (const part of String(value || "").split(";")) {
    const item = part.trim();
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    result.push([item.slice(0, separator).trim(), item.slice(separator + 1)]);
  }
  return result;
}

function cookieValue(header, name) {
  return cookiesFromHeader(header).find(([key]) => key === name)?.[1];
}

function withoutDirectCookie(header) {
  const kept = cookiesFromHeader(header).filter(
    ([name]) => name !== directCookieName,
  );
  return kept.map(([name, value]) => name + "=" + value).join("; ");
}

function hasDshAuthCookie(header) {
  return cookiesFromHeader(header).some(([name]) =>
    name.startsWith("dsh-auth-"),
  );
}

function scryptAsync(value, salt) {
  return new Promise((resolve, reject) => {
    scrypt(value, salt, 32, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function requestOriginMatches(request, authority, required) {
  const origin = request.headers.origin;
  if (origin === undefined) return !required;
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "http:" &&
      parsed.origin.toLowerCase() === externalOrigin(authority).toLowerCase() &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function externalOrigin(authority) {
  return "http://" + authority.authority;
}

function rewriteLocation(location, upstreamOrigin, browserOrigin) {
  if (typeof location !== "string" || location === "") return location;
  try {
    const target = new URL(location, upstreamOrigin);
    if (target.origin !== upstreamOrigin) return location;
    // The DSH launch token is an internal bootstrap credential; never echo it
    // back into a URL visible to the remote browser.
    target.searchParams.delete("token");
    return browserOrigin + target.pathname + target.search + target.hash;
  } catch {
    return location;
  }
}

function requestHeaders(request, upstreamOrigin) {
  const headers = {};
  const connectionTokens = new Set(
    String(request.headers.connection || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (
      value === undefined ||
      hopByHopHeaders.has(lower) ||
      connectionTokens.has(lower) ||
      lower === "host" ||
      lower === "authorization" ||
      lower === "x-forwarded-for" ||
      lower === "x-forwarded-host" ||
      lower === "x-forwarded-proto" ||
      lower === "forwarded"
    )
      continue;
    headers[lower] = value;
  }
  const cookie = withoutDirectCookie(request.headers.cookie);
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  if (request.headers.origin !== undefined) headers.origin = upstreamOrigin;
  if (request.headers.referer !== undefined)
    headers.referer = upstreamOrigin + "/";
  headers.host = new URL(upstreamOrigin).host;
  return headers;
}

function filterResponseHeaders(responseHeaders, upstreamOrigin, browserOrigin) {
  const headers = {};
  const connectionTokens = new Set(
    String(responseHeaders.connection || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(responseHeaders)) {
    const lower = name.toLowerCase();
    if (
      value === undefined ||
      hopByHopHeaders.has(lower) ||
      connectionTokens.has(lower)
    )
      continue;
    headers[lower] = value;
  }
  if (headers.location !== undefined)
    headers.location = rewriteLocation(
      headers.location,
      upstreamOrigin,
      browserOrigin,
    );
  return headers;
}

function securityHeaders() {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function loginPage(request, failed = false) {
  const language = String(
    request.headers["accept-language"] || "",
  ).toLowerCase();
  const chinese = language.startsWith("zh");
  const lang = chinese ? "zh-CN" : "en";
  const title = chinese ? "DSH 远程访问" : "DSH remote access";
  const description = chinese
    ? "输入插件访问密码以继续。此入口拥有完整 DSH Web 权限。"
    : "Enter the plugin access password. This grants full DSH Web access.";
  const label = chinese ? "访问密码" : "Access password";
  const button = chinese ? "登录" : "Sign in";
  const error = failed
    ? '<p role="alert">' +
      (chinese
        ? "密码错误或登录暂不可用。"
        : "Invalid password or login temporarily unavailable.") +
      "</p>"
    : "";
  return (
    '<!doctype html><html lang="' +
    lang +
    '"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    title +
    '</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#111827;color:#f9fafb}.card{width:min(420px,calc(100vw - 40px));box-sizing:border-box;padding:24px;border:1px solid #374151;border-radius:16px;background:#1f2937}label{display:block;margin:16px 0 6px}input,button{box-sizing:border-box;width:100%;padding:11px 12px;border-radius:8px;font:inherit}input{border:1px solid #4b5563;background:#111827;color:inherit}button{margin-top:16px;border:0;background:#60a5fa;color:#111827;font-weight:700;cursor:pointer}</style><main class="card"><h1>' +
    title +
    "</h1><p>" +
    description +
    "</p>" +
    error +
    '<form method="post" action="' +
    loginPath +
    '" autocomplete="on"><label for="password">' +
    label +
    '</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">' +
    button +
    "</button></form></main></html>"
  );
}

function writePlain(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(body);
}

function rejectUpgrade(socket, status = 403, message = "Forbidden") {
  const body = message + "\n";
  const statusText =
    status === 401
      ? "Unauthorized"
      : status === 404
        ? "Not Found"
        : "Forbidden";
  try {
    socket.end(
      "HTTP/1.1 " +
        status +
        " " +
        statusText +
        "\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: " +
        Buffer.byteLength(body) +
        "\r\n\r\n" +
        body,
    );
  } catch {
    socket.destroy();
  }
}

export class DirectAccessServer {
  constructor(options = {}) {
    const validated = validateDirectAccessOptions(options);
    this.host = validated.host;
    this.port = validated.port;
    this.password = validated.password;
    this.localOrigin = validated.upstream.origin;
    this.startupUrl = options.startupUrl;
    this.onError =
      options.onError ||
      ((error) =>
        console.error(
          "[dsh-manager-plugin] direct access error:",
          error.message,
        ));
    this.closed = false;
    this.server = null;
    this.wss = null;
    this.started = false;
    this.startPromise = null;
    this.closePromise = null;
    this.sessions = new Map();
    this.loginAttempts = new Map();
    this.activePasswordChecks = 0;
    this.websocketPairs = new Set();
    this.passwordSalt = this.password ? randomBytes(16) : null;
    this.passwordHash = null;
  }

  start() {
    if (this.started) return Promise.resolve(this.address());
    if (this.startPromise) return this.startPromise;
    if (this.closed)
      return Promise.reject(new Error("Direct access server is closed"));
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  async startInternal() {
    if (this.password)
      this.passwordHash = await scryptAsync(this.password, this.passwordSalt);
    if (this.closed)
      throw new Error("Direct access server was closed before listen");
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: maxWebSocketPayload,
    });
    this.server = http.createServer((request, response) => {
      this.handleHttp(request, response).catch((error) => {
        this.onError(error);
        if (!response.headersSent)
          writePlain(
            response,
            502,
            "The local DSH Web service is unavailable.",
          );
        else response.destroy();
      });
    });
    this.server.maxConnections = 128;
    this.server.keepAliveTimeout = 5000;
    this.server.headersTimeout = 15000;
    this.server.requestTimeout = 5 * 60 * 1000;
    this.server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head).catch((error) => {
        this.onError(error);
        rejectUpgrade(socket, 502, "Bad Gateway");
      });
    });
    this.server.on("error", (error) => {
      if (this.started) this.onError(error);
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.removeListener("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
    if (this.closed) {
      await this.stopListening();
      throw new Error("Direct access server was closed while starting");
    }
    this.started = true;
    const address = this.server.address();
    if (address && typeof address === "object") this.port = address.port;
    console.info(
      "[dsh-manager-plugin] direct access listening:",
      this.host + ":" + this.port,
      this.password
        ? "password=required"
        : isLoopbackAddress(this.host)
          ? "password=disabled-loopback-only"
          : "password=disabled-unauthenticated",
    );
    return this.address();
  }

  async stopListening() {
    if (!this.server || !this.server.listening) {
      this.started = false;
      return;
    }
    await new Promise((resolve) => {
      try {
        this.server.close(() => resolve());
        this.server.closeAllConnections?.();
      } catch {
        resolve();
      }
    });
    this.started = false;
  }

  address() {
    return { host: this.host, port: this.port };
  }

  parseTarget(request) {
    const target = parseRequestTarget(request.url);
    if (!target) return null;
    const authority = parseAuthority(request.headers.host);
    if (!authority || authority.port !== this.port) return null;
    const localAddress = normalizeAddress(request.socket.localAddress);
    const hostMatchesLocal = authority.hostname === localAddress;
    const localhostAlias =
      authority.hostname === "localhost" && isLoopbackAddress(localAddress);
    if (!hostMatchesLocal && !localhostAlias) return null;
    if (
      String(request.headers["sec-fetch-site"] || "").toLowerCase() ===
      "cross-site"
    )
      return null;
    if (!requestOriginMatches(request, authority, false)) return null;
    return { target, authority };
  }

  sessionFromRequest(request) {
    if (!this.password) return { key: "loopback", expiresAt: Infinity };
    const token = cookieValue(request.headers.cookie, directCookieName);
    if (!token) return null;
    const key = sha256(token);
    const expiresAt = this.sessions.get(key);
    if (!expiresAt || expiresAt <= Date.now()) {
      this.sessions.delete(key);
      return null;
    }
    return { key, expiresAt };
  }

  takeLoginAttempt(request) {
    const key = normalizeAddress(request.socket.remoteAddress) || "unknown";
    const now = Date.now();
    const recent = (this.loginAttempts.get(key) || []).filter(
      (time) => now - time < loginWindowMs,
    );
    if (recent.length >= maxLoginAttempts) {
      this.loginAttempts.set(key, recent);
      return false;
    }
    recent.push(now);
    this.loginAttempts.set(key, recent);
    if (this.loginAttempts.size > 4096) {
      for (const [address, attempts] of this.loginAttempts) {
        if (attempts.every((time) => now - time >= loginWindowMs))
          this.loginAttempts.delete(address);
      }
    }
    return true;
  }

  async verifyPassword(candidate) {
    if (!this.password || typeof candidate !== "string") return false;
    if (this.activePasswordChecks >= 4) return null;
    this.activePasswordChecks++;
    try {
      const digest = await scryptAsync(candidate, this.passwordSalt);
      return timingSafeEqual(digest, this.passwordHash);
    } finally {
      this.activePasswordChecks--;
    }
  }

  async readLoginBody(request) {
    const contentType = String(
      request.headers["content-type"] || "",
    ).toLowerCase();
    if (!contentType.startsWith("application/x-www-form-urlencoded"))
      throw new Error("Unsupported login content type");
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxLoginBodyBytes) {
      request.resume();
      throw new Error("Login request is too large");
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > maxLoginBodyBytes) {
        request.resume();
        throw new Error("Login request is too large");
      }
      chunks.push(chunk);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }

  async handleLogin(request, response, authority) {
    if (!this.password) return writePlain(response, 404, "Not found");
    if (!requestOriginMatches(request, authority, true))
      return writePlain(
        response,
        403,
        "Cross-origin login is not allowed",
        securityHeaders(),
      );
    if (!this.takeLoginAttempt(request))
      return writePlain(response, 429, "Too many login attempts", {
        ...securityHeaders(),
        "Retry-After": "60",
      });
    let form;
    try {
      form = await this.readLoginBody(request);
    } catch {
      return writePlain(
        response,
        400,
        "Invalid login request",
        securityHeaders(),
      );
    }
    const passwordMatches = await this.verifyPassword(form.get("password"));
    if (passwordMatches === null)
      return writePlain(
        response,
        429,
        "Login service is busy; try again shortly",
        securityHeaders(),
      );
    if (!passwordMatches) {
      response.writeHead(401, {
        ...securityHeaders(),
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(loginPage(request, true));
      return;
    }
    this.loginAttempts.delete(
      normalizeAddress(request.socket.remoteAddress) || "unknown",
    );
    for (const [key, expiresAt] of this.sessions) {
      if (expiresAt <= Date.now()) this.sessions.delete(key);
    }
    if (this.sessions.size >= 2048)
      return writePlain(
        response,
        503,
        "Too many active browser sessions",
        securityHeaders(),
      );
    const raw = randomBytes(32).toString("base64url");
    const hashed = sha256(raw);
    const expiresAt = Date.now() + sessionLifetimeMs;
    this.sessions.set(hashed, expiresAt);
    response.writeHead(303, {
      ...securityHeaders(),
      Location: "/",
      "Set-Cookie":
        directCookieName +
        "=" +
        raw +
        "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" +
        Math.floor(sessionLifetimeMs / 1000),
    });
    response.end();
  }

  async handleHttp(request, response) {
    const parsed = this.parseTarget(request);
    if (!parsed)
      return writePlain(response, 403, "Host or origin is not allowed");
    const { target, authority } = parsed;
    if (request.method === "TRACE")
      return writePlain(response, 405, "Method not allowed");
    if (target.pathname === loginPath && request.method === "GET") {
      if (!this.password) return writePlain(response, 404, "Not found");
      response.writeHead(200, {
        ...securityHeaders(),
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(loginPage(request));
      return;
    }
    if (target.pathname === loginPath && request.method === "POST")
      return this.handleLogin(request, response, authority);
    if (target.pathname === logoutPath && request.method === "POST") {
      if (!requestOriginMatches(request, authority, true))
        return writePlain(response, 403, "Cross-origin logout is not allowed");
      const session = this.sessionFromRequest(request);
      if (session && session.key !== "loopback")
        this.sessions.delete(session.key);
      response.writeHead(303, {
        ...securityHeaders(),
        Location: loginPath,
        "Set-Cookie":
          directCookieName + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
      });
      response.end();
      return;
    }
    const session = this.sessionFromRequest(request);
    if (!session) {
      response.writeHead(401, {
        ...securityHeaders(),
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(loginPage(request));
      return;
    }
    return this.proxyHttp(request, response, target, authority);
  }

  proxyHttp(request, response, target, authority) {
    const bootstrap =
      request.method === "GET" &&
      target.pathname === "/" &&
      !hasDshAuthCookie(request.headers.cookie);
    const destination = bootstrap
      ? new URL(this.startupUrl)
      : new URL(target.pathname + target.search, this.localOrigin);
    const headers = requestHeaders(request, this.localOrigin);
    const browserOrigin = externalOrigin(authority);
    const upstream = http.request(
      {
        protocol: "http:",
        hostname: "127.0.0.1",
        port: new URL(this.localOrigin).port,
        path: destination.pathname + destination.search,
        method: request.method,
        headers,
      },
      (upstreamResponse) => {
        const responseHeaders = filterResponseHeaders(
          upstreamResponse.headers,
          this.localOrigin,
          browserOrigin,
        );
        response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
        upstreamResponse.pipe(response);
      },
    );
    upstream.setTimeout(5 * 60 * 1000, () =>
      upstream.destroy(new Error("Local DSH request timed out")),
    );
    upstream.on("error", (error) => {
      this.onError(error);
      if (!response.headersSent)
        writePlain(response, 502, "The local DSH Web service is unavailable.");
      else response.destroy();
    });
    request.on("aborted", () =>
      upstream.destroy(new Error("Browser request aborted")),
    );
    response.on("close", () => {
      if (!response.writableEnded)
        upstream.destroy(new Error("Browser connection closed"));
    });
    request.pipe(upstream);
  }

  async handleUpgrade(request, socket, head) {
    const parsed = this.parseTarget(request);
    if (!parsed)
      return rejectUpgrade(socket, 403, "Host or origin is not allowed");
    const { target, authority } = parsed;
    if (!requestOriginMatches(request, authority, true))
      return rejectUpgrade(socket, 403, "WebSocket origin is required");
    if (!this.sessionFromRequest(request))
      return rejectUpgrade(socket, 401, "Plugin access password required");
    const destination = new URL(
      target.pathname + target.search,
      this.localOrigin,
    );
    destination.protocol = "ws:";
    const headers = requestHeaders(request, this.localOrigin);
    headers.origin = this.localOrigin;
    headers.referer = this.localOrigin + "/";
    const upstream = new WebSocket(destination, {
      headers,
      handshakeTimeout: websocketHandshakeTimeoutMs,
      maxPayload: maxWebSocketPayload,
    });
    const pair = { client: null, upstream };
    this.websocketPairs.add(pair);
    let settled = false;
    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      this.websocketPairs.delete(pair);
      upstream.terminate();
      rejectUpgrade(socket, status, message);
    };
    const timer = setTimeout(
      () => fail(502, "Local DSH WebSocket timed out"),
      websocketHandshakeTimeoutMs,
    );
    timer.unref?.();
    upstream.once("unexpected-response", (_request, upstreamResponse) => {
      upstreamResponse.resume();
      fail(502, "Local DSH WebSocket refused the connection");
    });
    upstream.once("error", () =>
      fail(502, "Local DSH WebSocket is unavailable"),
    );
    upstream.once("open", () => {
      if (settled || this.closed || socket.destroyed) {
        clearTimeout(timer);
        upstream.terminate();
        return;
      }
      settled = true;
      clearTimeout(timer);
      this.wss.handleUpgrade(request, socket, head, (client) => {
        pair.client = client;
        this.wss.emit("connection", client, request);
        client.on("message", (data, isBinary) => {
          if (upstream.readyState !== WebSocket.OPEN) return;
          if (
            upstream.bufferedAmount + frameByteLength(data) >
            maxBufferedWebSocketBytes
          ) {
            client.close(1013, "Upstream is backpressured");
            upstream.terminate();
            return;
          }
          upstream.send(data, { binary: isBinary }, (error) => {
            if (error) client.terminate();
          });
        });
        upstream.on("message", (data, isBinary) => {
          if (client.readyState !== WebSocket.OPEN) return;
          if (
            client.bufferedAmount + frameByteLength(data) >
            maxBufferedWebSocketBytes
          ) {
            upstream.close(1013, "Browser is backpressured");
            client.terminate();
            return;
          }
          client.send(data, { binary: isBinary }, (error) => {
            if (error) upstream.terminate();
          });
        });
        const finish = () => {
          this.websocketPairs.delete(pair);
          if (client.readyState === WebSocket.OPEN)
            client.close(1000, "Upstream connection closed");
          if (upstream.readyState === WebSocket.OPEN)
            upstream.close(1000, "Browser connection closed");
        };
        client.once("close", finish);
        upstream.once("close", finish);
        client.on("error", () => upstream.terminate());
        upstream.on("error", () => client.terminate());
      });
    });
    socket.once("close", () => {
      clearTimeout(timer);
      if (
        upstream.readyState === WebSocket.CONNECTING ||
        upstream.readyState === WebSocket.OPEN
      )
        upstream.terminate();
    });
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.sessions.clear();
    for (const pair of this.websocketPairs) {
      pair.client?.terminate();
      pair.upstream.terminate();
    }
    this.websocketPairs.clear();
    try {
      this.wss?.close();
    } catch {}
    this.closePromise = (async () => {
      if (this.startPromise && !this.started)
        await this.startPromise.catch(() => {});
      await this.stopListening();
    })();
    return this.closePromise;
  }
}
