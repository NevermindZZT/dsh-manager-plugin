import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import {
  installSettingsSection,
  settingsNamespace,
} from "@deepseek-ai/dsh-settings";
import { ManagerTunnel } from "./tunnel.js";

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
    const saved = readState(file);
    const entry = {
      enabled: config.enabled !== false,
      serverUrl:
        config.serverUrl ||
        process.env.DSH_MANAGER_URL ||
        saved.serverUrl ||
        "",
      pairingCode:
        config.pairingCode || process.env.DSH_MANAGER_PAIRING_CODE || "",
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
      writeState(file, {
        ...saved,
        serverUrl: settings.serverUrl,
        name: settings.name,
        instanceId: settings.instanceId,
        tlsFingerprint: settings.tlsFingerprint,
      });
      if (tunnel) {
        tunnel.close();
        tunnel = null;
      }

      if (!settings.enabled || !settings.serverUrl) {
        console.warn(
          "[dsh-manager-plugin] disabled: configure dsh-manager in Settings or set DSH_MANAGER_URL",
        );
        return;
      }
      tunnel = new ManagerTunnel({
        ...config,
        serverUrl: settings.serverUrl,
        pairingCode: settings.pairingCode,
        agentId:
          config.agentId || process.env.DSH_MANAGER_AGENT_ID || saved.agentId,
        agentToken:
          config.agentToken ||
          process.env.DSH_MANAGER_AGENT_TOKEN ||
          saved.agentToken,
        tlsFingerprint: settings.tlsFingerprint,
        name: settings.name,
        instanceId: settings.instanceId,
        pluginVersion: config.pluginVersion || "0.1.3",
        localOrigin: "http://127.0.0.1:" + ctx.webServer.port,
        onEnrollment: (result) => {
          writeState(file, {
            ...saved,
            ...result,
            serverUrl: settings.serverUrl,
            name: settings.name,
          });
          config.onEnrollment?.(result);
        },
      });
      tunnel.start().catch((error) => {
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
