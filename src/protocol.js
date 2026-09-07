export const DEFAULT_CAPABILITIES = [
  "proxy.http",
  "proxy.websocket",
  "settings.host",
  "plugin.config",
  "dsh.web.bootstrap-v1",
  "proxy.binary-response-v1",
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
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Manager URL 必须使用 http:// 或 https://");
  return url;
}

export function managerUrls(serverUrl) {
  const base = validateManagerUrl(serverUrl);
  const enroll = new URL("/api/v1/agents/enroll", base);
  const connect = new URL("/api/v1/agent/connect", base);
  connect.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return { base, enroll, connect };
}
export function shouldAllowEnrollment({
  agentId,
  agentToken,
  pairingCode,
  pairingChanged,
  managerChanged,
}) {
  const credentialsMissing =
    !String(agentId || "").trim() || !String(agentToken || "").trim();
  const pairingAvailable = String(pairingCode || "").trim() !== "";
  return (
    pairingAvailable && (credentialsMissing || pairingChanged || managerChanged)
  );
}

export function enrollmentPayload(config) {
  return {
    pairingCode: config.pairingCode || "",
    name: config.name || "dsh-plugin",
    platform: process.platform,
    launcherVersion: "",
    agentType: "dsh-plugin",
    agentVersion: process.version,
    pluginVersion: config.pluginVersion || "0.2.0",
    capabilities: normalizeCapabilities(
      config.capabilities || DEFAULT_CAPABILITIES,
    ),
  };
}
