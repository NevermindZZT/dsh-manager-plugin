export const DEFAULT_CAPABILITIES = [
  "proxy.http",
  "proxy.websocket",
  "settings.host",
  "plugin.config",
];
export function normalizeCapabilities(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const item = String(value || "")
      .trim()
      .toLowerCase();
    if (item && !seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}
export function validateManagerUrl(serverUrl) {
  const url = new URL(serverUrl);
  const port = url.port;
  const httpsPorts = new Set(["443", "8443", "18443", "19443", "10091"]);
  const httpPorts = new Set(["80", "8080", "18080", "19080", "10090"]);
  if (url.protocol === "http:" && httpsPorts.has(port))
    throw new Error(
      "Manager URL 使用了 HTTP，但当前端口是 HTTPS/WSS 端口；请改为 https://",
    );
  if (url.protocol === "https:" && httpPorts.has(port))
    throw new Error(
      "Manager URL 使用了 HTTPS，但当前端口是 HTTP 端口；请改为 http:// 或填写 Agent HTTPS 端口",
    );
  return url;
}

export function managerUrls(serverUrl) {
  const base = validateManagerUrl(serverUrl);
  const enroll = new URL("/api/v1/agents/enroll", base);
  const connect = new URL("/api/v1/agent/connect", base);
  connect.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return { base, enroll, connect };
}
export function enrollmentPayload(config) {
  return {
    pairingCode: config.pairingCode || "",
    name: config.name || "dsh-plugin",
    platform: process.platform,
    launcherVersion: "",
    agentType: "dsh-plugin",
    agentVersion: process.version,
    pluginVersion: config.pluginVersion || "0.1.2",
    capabilities: normalizeCapabilities(
      config.capabilities || DEFAULT_CAPABILITIES,
    ),
  };
}
