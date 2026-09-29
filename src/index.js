import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { ManagerTunnel } from "./tunnel.js";
import { DirectAccessServer } from "./direct-access.js";
import { shouldAllowEnrollment } from "./protocol.js";

export const name = "dsh-manager-plugin";
export const DSH_MANAGER_SETTINGS_ENTRY_ID = name;
export const DSH_MANAGER_SETTINGS_ENTRY_PACKAGE_ID =
  "@nevermindzzt/dsh-manager-plugin";
export const DSH_MANAGER_SETTINGS_ENTRY_IDS = Object.freeze([
  DSH_MANAGER_SETTINGS_ENTRY_ID,
  DSH_MANAGER_SETTINGS_ENTRY_PACKAGE_ID,
]);
const DEFAULT_AGENT_NAME = "dsh-plugin";
const DEFAULT_INSTANCE_ID = "default";

function volatile(schema) {
  return typeof schema.volatile === "function"
    ? schema.volatile()
    : schema.extra("volatile", true);
}

export const DSH_MANAGER_SETTINGS_SCHEMA = z.object({
  enabled: volatile(z.boolean().default(true)),
  serverUrl: volatile(z.string().default("")),
  pairingCode: volatile(z.string().default("").role("secret")),
  name: volatile(z.string().default(DEFAULT_AGENT_NAME)),
  instanceId: volatile(z.string().default(DEFAULT_INSTANCE_ID)),
  directAccessEnabled: volatile(z.boolean().default(false)),
  directAccessHost: volatile(z.string().default("127.0.0.1")),
  directAccessPort: volatile(z.number().default(3081)),
  // No empty default: DSH marks an empty secret default as configured.
  directAccessPassword: volatile(z.string().role("secret")),
});
export const Config = DSH_MANAGER_SETTINGS_SCHEMA;

function configValue(value) {
  return value && typeof value.get === "function" ? value.get() : value;
}

export function resolveManagerSettings(
  config = {},
  saved = {},
  env = process.env,
  userConfig,
) {
  const enabled = configValue(config.enabled);
  const serverUrl = configValue(config.serverUrl);
  const pairingCode = configValue(config.pairingCode);
  const configuredName = configValue(config.name);
  const configuredInstanceId = configValue(config.instanceId);
  const hasUserValue = (key) =>
    userConfig !== undefined && Object.hasOwn(userConfig, key);
  return {
    enabled: hasUserValue("enabled")
      ? (configValue(userConfig.enabled) ?? enabled ?? true)
      : (enabled ?? true),
    serverUrl: hasUserValue("serverUrl")
      ? (configValue(userConfig.serverUrl) ?? serverUrl ?? "")
      : serverUrl || env.DSH_MANAGER_URL || saved.serverUrl || "",
    pairingCode:
      pairingCode || env.DSH_MANAGER_PAIRING_CODE || saved.pairingCode || "",
    name: hasUserValue("name")
      ? (configValue(userConfig.name) ?? configuredName ?? DEFAULT_AGENT_NAME)
      : configuredName && configuredName !== DEFAULT_AGENT_NAME
        ? configuredName
        : env.DSH_MANAGER_NAME || saved.name || DEFAULT_AGENT_NAME,
    instanceId: hasUserValue("instanceId")
      ? (configValue(userConfig.instanceId) ??
        configuredInstanceId ??
        DEFAULT_INSTANCE_ID)
      : configuredInstanceId && configuredInstanceId !== DEFAULT_INSTANCE_ID
        ? configuredInstanceId
        : env.DSH_MANAGER_INSTANCE_ID ||
          saved.instanceId ||
          DEFAULT_INSTANCE_ID,
  };
}

function projectEffectiveSettings(config, settings) {
  if (config === null || typeof config !== "object") return;
  // Manager fields can fall back to environment/local state. Direct-access
  // fields have no external fallback, so do not mirror them into Config: doing
  // so would turn a user reset into a new effective override.
  for (const field of ["serverUrl", "name", "instanceId"]) {
    const current = config[field];
    try {
      if (current && typeof current.set === "function")
        current.set(settings[field]);
      else config[field] = settings[field];
    } catch {}
  }
}

export function listenForSettingsUpdates(ctx, onUpdate) {
  ctx.inject(["settings"], (sctx) => {
    const lastRevisions = new Map();
    const refresh = (expectedRevision, expectedEntryId) => {
      try {
        // Ordinary overrides stay redacted. Read only this plugin's direct
        // password when its secret slot is marked configured; never forward,
        // log, or retain other plugin secrets.
        const descriptors = sctx.settings.describe({ redactSecrets: true });
        const descriptor =
          descriptors.find((entry) => entry.ns === expectedEntryId) ??
          descriptors.find((entry) =>
            DSH_MANAGER_SETTINGS_ENTRY_IDS.includes(entry.ns),
          );
        const entryId = descriptor?.ns;
        const revision = descriptor?.revision;
        const lastRevision = entryId && lastRevisions.get(entryId);
        if (
          typeof revision === "number" &&
          typeof expectedRevision === "number" &&
          revision < expectedRevision
        )
          return;
        if (
          typeof revision === "number" &&
          typeof lastRevision === "number" &&
          revision <= lastRevision
        )
          return;
        if (entryId && typeof revision === "number")
          lastRevisions.set(entryId, revision);
        const passwordIsSet = Boolean(
          descriptor?.secrets?.some(
            (secret) =>
              secret.path.length === 1 &&
              secret.path[0] === "directAccessPassword" &&
              secret.set,
          ),
        );
        let directAccessPassword = "";
        if (passwordIsSet) {
          const full = sctx.settings
            .describe()
            .find((entry) => entry.ns === entryId);
          directAccessPassword = String(
            full?.user?.directAccessPassword ||
              full?.value?.directAccessPassword ||
              "",
          );
        }
        onUpdate(descriptor?.user, {
          directAccessPassword,
          directAccessPasswordConfigured: passwordIsSet,
        });
      } catch {
        if (expectedEntryId) lastRevisions.delete(expectedEntryId);
        // If the Settings store cannot be read, fail closed rather than silently
        // turning a previously configured external listener into open access.
        onUpdate(undefined, {
          directAccessPassword: "",
          directAccessPasswordConfigured: true,
        });
      }
    };
    refresh();
    sctx.on("settings/document-updated", (entryId, revision) => {
      if (!DSH_MANAGER_SETTINGS_ENTRY_IDS.includes(entryId)) return;
      const lastRevision = lastRevisions.get(entryId);
      if (
        typeof revision === "number" &&
        typeof lastRevision === "number" &&
        revision <= lastRevision
      )
        return;
      refresh(revision, entryId);
    });
  });
}

export function resolveDirectAccessSettings(
  config = {},
  userConfig,
  secretConfig = {},
) {
  const directAccessEnabled = configValue(config.directAccessEnabled);
  const directAccessHost = configValue(config.directAccessHost);
  const directAccessPort = configValue(config.directAccessPort);
  const hasUserValue = (key) =>
    userConfig !== undefined && Object.hasOwn(userConfig, key);
  const effective = (key, current, fallback) =>
    hasUserValue(key)
      ? (configValue(userConfig[key]) ?? current ?? fallback)
      : (current ?? fallback);
  const hasSecretSnapshot =
    typeof secretConfig.directAccessPasswordConfigured === "boolean";
  const configPassword = String(configValue(config.directAccessPassword) || "");
  const password = hasSecretSnapshot
    ? String(secretConfig.directAccessPassword || "")
    : configPassword;
  return {
    enabled: effective("directAccessEnabled", directAccessEnabled, false),
    host: effective("directAccessHost", directAccessHost, "127.0.0.1"),
    port: Number(effective("directAccessPort", directAccessPort, 3081)),
    password,
    passwordConfigured: hasSecretSnapshot
      ? secretConfig.directAccessPasswordConfigured
      : configPassword.length > 0,
  };
}

export function resolveTunnelCredentials(
  config,
  saved,
  settings,
  managerChanged,
  env = process.env,
) {
  const agentId =
    configValue(config.agentId) ||
    env.DSH_MANAGER_AGENT_ID ||
    (managerChanged ? "" : saved.agentId) ||
    "";
  const agentToken =
    configValue(config.agentToken) ||
    env.DSH_MANAGER_AGENT_TOKEN ||
    (managerChanged ? "" : saved.agentToken) ||
    "";
  const pairingChanged =
    String(saved.pairingCode || "") !== String(settings.pairingCode || "");
  return {
    agentId,
    agentToken,
    pairingChanged,
    allowEnrollment: shouldAllowEnrollment({
      agentId,
      agentToken,
      pairingCode: settings.pairingCode,
      pairingChanged,
      managerChanged,
    }),
  };
}

function statePath(config) {
  return (
    config.statePath ||
    process.env.DSH_MANAGER_STATE_PATH ||
    path.join(os.homedir(), ".dsh", "manager-agent.json")
  );
}
function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

export function applyManagerAgent(
  ctx,
  config = {},
  Tunnel = ManagerTunnel,
  env = process.env,
  DirectServer = DirectAccessServer,
) {
  const file = statePath(config);
  let saved = readState(file);
  let tunnel = null;
  let directServer = null;
  let disposed = false;
  let syncScheduled = false;
  let lastSettingsKey = "";
  let lastDirectSettings = null;
  let syncGeneration = 0;
  let directGeneration = 0;
  let userConfig;
  let secretConfig = {};

  const syncDirectAccess = (settings) => {
    const previousSettings = lastDirectSettings;
    if (
      previousSettings &&
      previousSettings.enabled === settings.enabled &&
      previousSettings.host === settings.host &&
      previousSettings.port === settings.port &&
      previousSettings.password === settings.password &&
      previousSettings.passwordConfigured === settings.passwordConfigured
    )
      return;
    lastDirectSettings = { ...settings };
    const generation = ++directGeneration;
    const previousServer = directServer;
    directServer = null;
    const replace = async () => {
      try {
        await previousServer?.close();
      } catch {}
      if (disposed || generation !== directGeneration || !settings.enabled)
        return;
      const localOrigin = "http://127.0.0.1:" + ctx.webServer.port;
      let nextServer;
      try {
        nextServer = new DirectServer({
          host: settings.host,
          port: settings.port,
          password: settings.password,
          passwordConfigured: settings.passwordConfigured,
          localOrigin,
          startupUrl: ctx.connection.authenticatedUrl(localOrigin),
          onError: (error) => {
            if (disposed || generation !== directGeneration) return;
            console.error(
              "[dsh-manager-plugin] direct access error:",
              error.message,
            );
            config.onError?.(error);
          },
        });
        directServer = nextServer;
        await nextServer.start();
        if (disposed || generation !== directGeneration) {
          if (directServer === nextServer) directServer = null;
          await nextServer.close();
        }
      } catch (error) {
        if (directServer === nextServer) directServer = null;
        if (!disposed && generation === directGeneration) {
          console.error(
            "[dsh-manager-plugin] direct access failed to start:",
            error.message,
          );
          config.onError?.(error);
        }
        await nextServer?.close();
      }
    };
    void replace();
  };

  const syncTunnel = () => {
    if (disposed) return;
    const settingsSnapshot = resolveManagerSettings(
      config,
      saved,
      env,
      userConfig,
    );
    const directSettings = resolveDirectAccessSettings(
      config,
      userConfig,
      secretConfig,
    );
    projectEffectiveSettings(config, settingsSnapshot);
    // This listener is independent of the outbound Manager connection.
    syncDirectAccess(directSettings);

    const settingsKey = JSON.stringify(settingsSnapshot);
    if (settingsKey === lastSettingsKey) return;
    lastSettingsKey = settingsKey;
    const generation = ++syncGeneration;
    const managerChanged =
      String(saved.serverUrl || "") !==
      String(settingsSnapshot.serverUrl || "");
    const credentials = resolveTunnelCredentials(
      config,
      saved,
      settingsSnapshot,
      managerChanged,
      env,
    );
    saved = {
      ...saved,
      serverUrl: settingsSnapshot.serverUrl,
      pairingCode: settingsSnapshot.pairingCode,
      name: settingsSnapshot.name,
      instanceId: settingsSnapshot.instanceId,
    };
    // Pairing codes are enrollment secrets, not connection credentials. A
    // changed code must never discard a valid Agent token; it is only made
    // available for an enrollment when the current credentials are absent.
    writeState(file, saved);

    const previousTunnel = tunnel;
    if (!settingsSnapshot.enabled || !settingsSnapshot.serverUrl) {
      tunnel = null;
      previousTunnel?.close();
      console.info(
        "[dsh-manager-plugin] Manager tunnel disabled; direct access is configured independently",
      );
      return;
    }

    let localTunnel;
    const configuredAgentId = credentials.agentId;
    const configuredAgentToken = credentials.agentToken;
    localTunnel = new Tunnel({
      ...config,
      serverUrl: settingsSnapshot.serverUrl,
      pairingCode: settingsSnapshot.pairingCode,
      // Keep saved credentials even when the enrollment secret changes. A
      // valid Agent reconnects with its token and never needs pairingCode.
      agentId: configuredAgentId,
      agentToken: configuredAgentToken,
      // A configured pairing code authorizes enrollment when credentials are
      // absent (including the first run). With valid credentials, only a
      // changed manager URL/code permits replacement enrollment.
      allowEnrollment: credentials.allowEnrollment,
      onCredentialsRejected: () => {
        if (disposed || generation !== syncGeneration || tunnel !== localTunnel)
          return;
        delete saved.agentId;
        delete saved.agentToken;
        writeState(file, saved);
      },
      name: settingsSnapshot.name,
      instanceId: settingsSnapshot.instanceId,
      pluginVersion: config.pluginVersion || "0.3.0",
      localOrigin: "http://127.0.0.1:" + ctx.webServer.port,
      startupUrl: ctx.connection.authenticatedUrl(
        "http://127.0.0.1:" + ctx.webServer.port,
      ),
      onEnrollment: (result) => {
        if (disposed || generation !== syncGeneration || tunnel !== localTunnel)
          return;
        saved = {
          ...saved,
          ...result,
          serverUrl: settingsSnapshot.serverUrl,
          pairingCode: settingsSnapshot.pairingCode,
          name: settingsSnapshot.name,
        };
        writeState(file, saved);
        config.onEnrollment?.(result);
      },
    });
    tunnel = localTunnel;
    // Replace the old transport only after the new generation is visible, so
    // late close/enrollment callbacks cannot mutate the active generation.
    previousTunnel?.close();
    localTunnel.start().catch((error) => {
      if (
        disposed ||
        generation !== syncGeneration ||
        tunnel !== localTunnel ||
        error?.code === "MANAGER_TUNNEL_CLOSED"
      )
        return;
      console.error("[dsh-manager-plugin] connection failed:", error);
      config.onError?.(error);
    });
  };
  const scheduleSync = () => {
    if (syncScheduled) return;
    syncScheduled = true;
    // Start listeners after dsh has finished booting its web server.
    const timer = setTimeout(() => {
      syncScheduled = false;
      if (!disposed) syncTunnel();
    }, 0);
    timer.unref?.();
  };

  listenForSettingsUpdates(ctx, (currentUserConfig, currentSecretConfig) => {
    userConfig = currentUserConfig;
    secretConfig = currentSecretConfig || {};
    scheduleSync();
  });
  scheduleSync();
  return async () => {
    disposed = true;
    syncGeneration++;
    directGeneration++;
    tunnel?.close();
    tunnel = null;
    const server = directServer;
    directServer = null;
    await server?.close();
  };
}

export const inject = ["webServer", "connection"];

export function apply(ctx, config = {}) {
  return applyManagerAgent(ctx, config);
}

export { ManagerTunnel } from "./tunnel.js";
