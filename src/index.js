import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import {
  installSettingsSection,
  settingsNamespace,
} from "@deepseek-ai/dsh-settings";
import { ManagerTunnel } from "./tunnel.js";
import { shouldAllowEnrollment } from "./protocol.js";

export const name = "dsh-manager-plugin";
export const DSH_MANAGER_SETTINGS_NAMESPACE = settingsNamespace("dsh-manager");
export const DSH_MANAGER_SETTINGS_SCHEMA = z.object({
  enabled: z.boolean(),
  serverUrl: z.string(),
  pairingCode: z.string(),
  name: z.string(),
  instanceId: z.string(),
  tlsFingerprint: z.string(),
});

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

export default {
  name,
  inject: ["webServer"],
  apply(ctx, config = {}) {
    const file = statePath(config);
    let saved = readState(file);
    const entry = {
      enabled: config.enabled !== false,
      serverUrl:
        config.serverUrl ||
        process.env.DSH_MANAGER_URL ||
        saved.serverUrl ||
        "",
      pairingCode:
        config.pairingCode ||
        process.env.DSH_MANAGER_PAIRING_CODE ||
        saved.pairingCode ||
        "",
      name:
        config.name ||
        process.env.DSH_MANAGER_NAME ||
        saved.name ||
        "dsh-plugin",
      instanceId:
        config.instanceId || process.env.DSH_MANAGER_INSTANCE_ID || "default",
      tlsFingerprint:
        config.tlsFingerprint || process.env.DSH_MANAGER_TLS_FINGERPRINT || "",
    };
    let source = () => entry;
    let sourceReady = false;
    let tunnel = null;
    let disposed = false;
    let syncScheduled = false;
    let syncTimer = null;
    let lastSettingsKey = "";
    let syncGeneration = 0;

    const syncTunnel = () => {
      if (disposed || !sourceReady) return;
      const settings = source();
      const settingsKey = JSON.stringify({
        enabled: settings.enabled,
        serverUrl: settings.serverUrl,
        pairingCode: settings.pairingCode,
        name: settings.name,
        instanceId: settings.instanceId,
        tlsFingerprint: settings.tlsFingerprint,
      });
      if (settingsKey === lastSettingsKey) return;
      lastSettingsKey = settingsKey;
      const generation = ++syncGeneration;
      const settingsSnapshot = { ...settings };
      const pairingChanged =
        String(saved.pairingCode || "") !==
        String(settingsSnapshot.pairingCode || "");
      const managerChanged =
        String(saved.serverUrl || "") !==
        String(settingsSnapshot.serverUrl || "");
      saved = {
        ...saved,
        serverUrl: settingsSnapshot.serverUrl,
        pairingCode: settingsSnapshot.pairingCode,
        name: settingsSnapshot.name,
        instanceId: settingsSnapshot.instanceId,
        tlsFingerprint: settingsSnapshot.tlsFingerprint,
      };
      // Pairing codes are enrollment secrets, not connection credentials. A
      // changed code must never discard a valid Agent token; it is only made
      // available for an enrollment when the current credentials are absent.
      writeState(file, saved);

      const previousTunnel = tunnel;
      if (!settingsSnapshot.enabled || !settingsSnapshot.serverUrl) {
        tunnel = null;
        previousTunnel?.close();
        console.warn(
          "[dsh-manager-plugin] disabled: configure dsh-manager in Settings or set DSH_MANAGER_URL",
        );
        return;
      }

      let localTunnel;
      const configuredAgentId =
        config.agentId ||
        process.env.DSH_MANAGER_AGENT_ID ||
        (managerChanged ? "" : saved.agentId) ||
        "";
      const configuredAgentToken =
        config.agentToken ||
        process.env.DSH_MANAGER_AGENT_TOKEN ||
        (managerChanged ? "" : saved.agentToken) ||
        "";
      localTunnel = new ManagerTunnel({
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
        allowEnrollment: shouldAllowEnrollment({
          agentId: configuredAgentId,
          agentToken: configuredAgentToken,
          pairingCode: settingsSnapshot.pairingCode,
          pairingChanged,
          managerChanged,
        }),
        onCredentialsRejected: () => {
          if (
            disposed ||
            generation !== syncGeneration ||
            tunnel !== localTunnel
          )
            return;
          delete saved.agentId;
          delete saved.agentToken;
          writeState(file, saved);
        },
        tlsFingerprint: settingsSnapshot.tlsFingerprint,
        name: settingsSnapshot.name,
        instanceId: settingsSnapshot.instanceId,
        pluginVersion: config.pluginVersion || "0.1.7",
        localOrigin: "http://127.0.0.1:" + ctx.webServer.port,
        onEnrollment: (result) => {
          if (
            disposed ||
            generation !== syncGeneration ||
            tunnel !== localTunnel
          )
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
      // Never perform enrollment or socket setup during plugin apply. Let dsh
      // finish booting first; the tunnel is an optional background service.
      const timer = setTimeout(() => {
        syncScheduled = false;
        if (!disposed) syncTunnel();
      }, 0);
      timer.unref?.();
    };

    installSettingsSection(
      ctx,
      DSH_MANAGER_SETTINGS_NAMESPACE,
      DSH_MANAGER_SETTINGS_SCHEMA,
      entry,
      {
        setSource: (current) => {
          source = current;
          sourceReady = true;
          scheduleSync();
        },
        onChange: scheduleSync,
      },
    );
    const readinessTimer = setTimeout(() => {
      if (!sourceReady) {
        sourceReady = true;
        scheduleSync();
      }
    }, 100);
    readinessTimer.unref?.();
    return () => {
      disposed = true;
      tunnel?.close();
      tunnel = null;
    };
  },
};

export { ManagerTunnel } from "./tunnel.js";
