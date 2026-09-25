import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  apply,
  applyManagerAgent,
  Config,
  DSH_MANAGER_SETTINGS_ENTRY_ID,
  DSH_MANAGER_SETTINGS_ENTRY_PACKAGE_ID,
  DSH_MANAGER_SETTINGS_SCHEMA,
  inject,
  listenForSettingsUpdates,
  name,
  resolveManagerSettings,
  resolveTunnelCredentials,
} from "../src/index.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const pkg = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);
const manifest = fs.readFileSync(
  path.join(packageRoot, "dsh.patch.yml"),
  "utf8",
);

function volatile(value) {
  return { get: () => value };
}

function serializedMeta(schema) {
  const json = schema.toJSON();
  return json.refs[String(schema.uid)]?.meta || {};
}

test("DSH 0.1.7-rc.2 discovers named plugin Config and defaults", () => {
  assert.equal(Config, DSH_MANAGER_SETTINGS_SCHEMA);
  assert.equal(name, "dsh-manager-plugin");
  assert.equal(typeof apply, "function");
  assert.deepEqual(inject, ["webServer", "connection"]);
  assert.equal(DSH_MANAGER_SETTINGS_ENTRY_ID, "dsh-manager-plugin");
  assert.match(manifest, /id: dsh-manager-plugin/);
  assert.deepEqual(DSH_MANAGER_SETTINGS_SCHEMA({}), {
    enabled: true,
    serverUrl: "",
    pairingCode: "",
    name: "dsh-plugin",
    instanceId: "default",
  });
});

test("every editable field serializes volatile metadata and pairing code is secret", () => {
  const fields = DSH_MANAGER_SETTINGS_SCHEMA.dict;
  for (const key of [
    "enabled",
    "serverUrl",
    "pairingCode",
    "name",
    "instanceId",
  ]) {
    assert.equal(fields[key].meta.volatile, true, key);
    assert.equal(serializedMeta(fields[key]).volatile, true, key);
  }
  assert.equal(fields.pairingCode.meta.role, "secret");
  assert.equal(serializedMeta(fields.pairingCode).role, "secret");
});

test("legacy saved connection settings survive empty DSH Config defaults", () => {
  const saved = {
    serverUrl: "http://legacy-manager:10090",
    pairingCode: "legacy-pairing",
    name: "legacy-agent",
    instanceId: "legacy-instance",
    agentId: "saved-agent",
    agentToken: "saved-token",
  };
  const config = {
    enabled: volatile(true),
    serverUrl: volatile(""),
    pairingCode: volatile(""),
    name: volatile("dsh-plugin"),
    instanceId: volatile("default"),
  };
  assert.deepEqual(resolveManagerSettings(config, saved, {}), {
    enabled: true,
    serverUrl: saved.serverUrl,
    pairingCode: saved.pairingCode,
    name: saved.name,
    instanceId: saved.instanceId,
  });
});

test("explicit DSH Config overrides win, including an intentionally blank URL", () => {
  const saved = {
    serverUrl: "http://legacy-manager:10090",
    pairingCode: "legacy-pairing",
    name: "legacy-agent",
    instanceId: "legacy-instance",
  };
  const config = {
    enabled: volatile(false),
    serverUrl: volatile(""),
    pairingCode: volatile("new-pairing"),
    name: volatile("configured-agent"),
    instanceId: volatile("configured-instance"),
  };
  assert.deepEqual(
    resolveManagerSettings(
      config,
      saved,
      {},
      {
        serverUrl: "",
        pairingCode: "new-pairing",
        name: "configured-agent",
        instanceId: "configured-instance",
      },
    ),
    {
      enabled: false,
      serverUrl: "",
      pairingCode: "new-pairing",
      name: "configured-agent",
      instanceId: "configured-instance",
    },
  );
});

test("changing pairing code keeps valid saved Agent credentials for reconnect", () => {
  const saved = {
    serverUrl: "http://manager:10090",
    pairingCode: "old-pairing",
    agentId: "saved-agent",
    agentToken: "saved-token",
  };
  const settings = {
    enabled: true,
    serverUrl: saved.serverUrl,
    pairingCode: "new-pairing",
    name: "dsh-plugin",
    instanceId: "default",
  };
  const credentials = resolveTunnelCredentials({}, saved, settings, false, {});
  assert.equal(credentials.agentId, saved.agentId);
  assert.equal(credentials.agentToken, saved.agentToken);
  assert.equal(credentials.pairingChanged, true);
  assert.equal(credentials.allowEnrollment, true);
});

test("rc.2 SettingsForms revisions refresh only this plugin's config", () => {
  const documentUpdateListeners = new Map();
  let user = { serverUrl: "http://initial-manager:10090" };
  let revision = 1;
  let describeCalls = 0;
  const updates = [];
  const ctx = {
    inject(services, callback) {
      assert.deepEqual(services, ["settings"]);
      callback({
        settings: {
          describe(options) {
            describeCalls++;
            assert.deepEqual(options, { redactSecrets: true });
            return [
              {
                ns: "other-plugin",
                user: { serverUrl: "http://other:10090" },
                revision: 7,
              },
              { ns: DSH_MANAGER_SETTINGS_ENTRY_ID, user, revision },
            ];
          },
        },
        on(event, listener) {
          assert.equal(event, "settings/document-updated");
          documentUpdateListeners.set(event, listener);
        },
      });
    },
  };

  listenForSettingsUpdates(ctx, (nextUser) => updates.push(nextUser));
  assert.deepEqual(updates, [user]);
  assert.equal(updates[0].pairingCode, undefined);
  const initialDescribeCalls = describeCalls;
  const onDocumentUpdated = documentUpdateListeners.get(
    "settings/document-updated",
  );

  onDocumentUpdated("other-plugin", 8);
  assert.equal(describeCalls, initialDescribeCalls);
  assert.equal(updates.length, 1);

  user = { serverUrl: "http://updated-manager:10090" };
  revision = 2;
  onDocumentUpdated(DSH_MANAGER_SETTINGS_ENTRY_ID, revision);
  assert.equal(describeCalls, initialDescribeCalls + 1);
  assert.deepEqual(updates[1], user);

  onDocumentUpdated(DSH_MANAGER_SETTINGS_ENTRY_ID, revision);
  onDocumentUpdated(DSH_MANAGER_SETTINGS_ENTRY_ID, 1);
  assert.equal(describeCalls, initialDescribeCalls + 1);
  assert.equal(updates.length, 2);

  user = { ...user, name: "updated-agent" };
  revision = 3;
  onDocumentUpdated(DSH_MANAGER_SETTINGS_ENTRY_ID, revision);
  assert.equal(describeCalls, initialDescribeCalls + 2);
  assert.deepEqual(updates[2], user);
});

test("SettingsForms listener accepts the scoped profile entry ID", () => {
  let currentUser = { name: "scoped-agent" };
  let revision = 1;
  let describeCalls = 0;
  let documentUpdated;
  const updates = [];
  const ctx = {
    inject(services, callback) {
      assert.deepEqual(services, ["settings"]);
      callback({
        settings: {
          describe(options) {
            describeCalls++;
            assert.deepEqual(options, { redactSecrets: true });
            return [
              {
                ns: DSH_MANAGER_SETTINGS_ENTRY_PACKAGE_ID,
                user: currentUser,
                revision,
              },
            ];
          },
        },
        on(event, listener) {
          assert.equal(event, "settings/document-updated");
          documentUpdated = listener;
        },
      });
    },
  };

  listenForSettingsUpdates(ctx, (user) => updates.push(user));
  assert.deepEqual(updates, [{ name: "scoped-agent" }]);
  currentUser = { name: "updated-scoped-agent" };
  revision = 2;
  documentUpdated(DSH_MANAGER_SETTINGS_ENTRY_PACKAGE_ID, revision);
  assert.deepEqual(updates[1], currentUser);
  const callsAfterUpdate = describeCalls;
  documentUpdated(DSH_MANAGER_SETTINGS_ENTRY_PACKAGE_ID, revision);
  documentUpdated(DSH_MANAGER_SETTINGS_ENTRY_PACKAGE_ID, 1);
  assert.equal(describeCalls, callsAfterUpdate);
  assert.equal(updates.length, 2);
});

test("RC2 ConfigForms client resolves scoped entry namespace and renders settings", () => {
  assert.equal(pkg.dsh.client.platform, "web");
  assert.ok(
    pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-settings"),
  );
  assert.ok(
    pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-primitives"),
  );
  assert.ok(
    pkg.dsh.client.inject.includes(
      "@deepseek-ai/dsh-client-ui-settings-plugins",
    ),
  );
  assert.ok(pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-runtime"));
  assert.ok(pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-slots"));
  assert.equal(pkg.exports["./client"], "./lib/client.js");
  assert.equal(pkg.files.includes("lib"), true);

  const clientBundle = fs.readFileSync(
    path.join(packageRoot, "lib", "client.js"),
    "utf8",
  );
  let definition;
  runInNewContext(clientBundle, {
    window: {
      __ModuleLoader__: {
        load(value) {
          definition = value;
        },
      },
    },
  });
  assert.equal(definition.id, pkg.name);

  const registrations = [];
  const disposers = [];
  const scope = {
    getSnapshot: () => ({
      status: "ready",
      value: {
        enabled: true,
        serverUrl: "",
        name: "dsh-plugin",
        instanceId: "default",
      },
      base: {},
      user: {},
      revision: 2,
      writable: true,
      mode: "host",
    }),
    subscribe: () => () => {},
    set: async () => true,
    mutate: async () => true,
  };
  let formModel;
  class FakeSettingsFormModel {
    constructor(formScope, specs, secrets) {
      this.scope = formScope;
      this.specs = specs;
      this.secrets = secrets;
      formModel = this;
    }
    shell() {
      return {
        available: true,
        writable: true,
        dirty: false,
        invalid: false,
        saving: false,
        failed: false,
      };
    }
    field(field) {
      const value = this.scope.getSnapshot().value[field];
      return {
        text:
          field === "enabled" ? String(value !== false) : String(value ?? ""),
        overridden: false,
        invalid: false,
      };
    }
    bind(project) {
      this.state = project();
      return { getSnapshot: () => this.state, subscribe: () => () => {} };
    }
    actions() {
      return { edit() {}, resetField() {}, save() {}, discard() {} };
    }
    dispose() {
      this.disposed = true;
    }
  }
  const primitives = {
    SettingsFormModel: FakeSettingsFormModel,
    SettingsForm() {},
    SettingsValueField() {},
    SettingsSecretField() {},
    Switch() {},
    settingsTextField: (field) => ({ field }),
  };
  const element = (type, props) => ({ type, props });
  const clientPlugin = definition.factory((id) => {
    if (id === "react/jsx-runtime") return { jsx: element, jsxs: element };
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
    throw new Error("unexpected client dependency: " + id);
  });
  assert.equal(clientPlugin.name, pkg.name);
  assert.equal(Array.from(clientPlugin.inject).join(","), "slots");

  const forms = {
    get(namespace) {
      assert.equal(namespace, DSH_MANAGER_SETTINGS_ENTRY_PACKAGE_ID);
      return scope;
    },
    describe() {
      return {
        getSnapshot: () => ({
          view: {
            namespaces: [
              {
                ns: DSH_MANAGER_SETTINGS_ENTRY_PACKAGE_ID,
                secrets: [{ path: ["pairingCode"], set: true }],
              },
            ],
          },
        }),
      };
    },
    whileServed(namespaces, register) {
      const watched = Array.from(namespaces);
      assert.ok(watched.includes(DSH_MANAGER_SETTINGS_ENTRY_ID));
      assert.ok(watched.includes(DSH_MANAGER_SETTINGS_ENTRY_PACKAGE_ID));
      return register(new Set([DSH_MANAGER_SETTINGS_ENTRY_PACKAGE_ID]));
    },
  };
  const clientContext = {
    configForms: forms,
    slots: {
      inject(slot, register) {
        assert.equal(slot, "plugins.bundle.config");
        return register();
      },
      register(metadata, component) {
        registrations.push({ metadata, component });
        return () => {};
      },
    },
    effect(effect) {
      disposers.push(effect());
    },
  };
  clientPlugin.apply({
    inject(services, callback) {
      assert.equal(Array.from(services).join(","), "configForms");
      callback(clientContext);
    },
  });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].metadata.name, "plugins.bundle.config");
  assert.equal(registrations[0].metadata.key, pkg.name);
  assert.equal(typeof registrations[0].component, "function");
  const card = registrations[0].component({
    useManagerSettings: (selector) => selector(formModel.state),
    edit() {},
    resetField() {},
    save() {},
    discard() {},
  });
  const rows = card.props.children.props.children;
  assert.equal(rows.length, 5);
  assert.equal(rows[0].type, primitives.Switch);
  assert.equal(rows[1].type, primitives.SettingsValueField);
  assert.equal(rows[2].type, primitives.SettingsSecretField);
  assert.equal(rows[2].props.configured, true);
  assert.equal(rows[2].props.label, "首次配对码");
  assert.equal(formModel.state.pairingCodeConfigured, true);
  for (const dispose of disposers) dispose?.();
  assert.equal(formModel.disposed, true);
});

test("settings updates rebuild the tunnel and preserve saved Agent credentials", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "dsh-manager-plugin-"),
  );
  const statePath = path.join(directory, "manager-agent.json");
  const saved = {
    serverUrl: "http://old-manager:10090",
    pairingCode: "old-pairing",
    name: "legacy-agent",
    instanceId: "legacy-instance",
    agentId: "saved-agent",
    agentToken: "saved-token",
  };
  fs.writeFileSync(statePath, JSON.stringify(saved));

  const current = {
    enabled: true,
    serverUrl: "",
    pairingCode: "",
    name: "dsh-plugin",
    instanceId: "default",
  };
  let user = {};
  let settingsRevision = 0;
  const listeners = new Map();
  const tunnels = [];
  class FakeTunnel {
    constructor(options) {
      this.options = options;
      this.closed = false;
      tunnels.push(this);
    }
    start() {
      return Promise.resolve();
    }
    close() {
      this.closed = true;
    }
  }
  const ctx = {
    webServer: { port: 12345 },
    connection: { authenticatedUrl: (baseUrl) => baseUrl },
    inject(services, callback) {
      assert.deepEqual(services, ["settings"]);
      callback({
        settings: {
          describe: (options) => {
            assert.deepEqual(options, { redactSecrets: true });
            return [
              {
                ns: DSH_MANAGER_SETTINGS_ENTRY_ID,
                user,
                revision: settingsRevision,
              },
            ];
          },
        },
        on(event, listener) {
          assert.equal(event, "settings/document-updated");
          listeners.set(event, listener);
        },
      });
    },
  };
  let pairingCodeSet = false;
  const config = {
    statePath,
    enabled: {
      get: () => current.enabled,
      set: (value) => {
        current.enabled = value;
      },
    },
    serverUrl: {
      get: () => current.serverUrl,
      set: (value) => {
        current.serverUrl = value;
      },
    },
    pairingCode: {
      get: () => current.pairingCode,
      set: () => {
        pairingCodeSet = true;
      },
    },
    name: {
      get: () => current.name,
      set: (value) => {
        current.name = value;
      },
    },
    instanceId: {
      get: () => current.instanceId,
      set: (value) => {
        current.instanceId = value;
      },
    },
  };
  const pauseForSync = () => new Promise((resolve) => setTimeout(resolve, 10));
  let dispose;
  try {
    dispose = applyManagerAgent(ctx, config, FakeTunnel, {});
    await pauseForSync();
    assert.equal(tunnels.length, 1);
    assert.equal(tunnels[0].options.serverUrl, saved.serverUrl);
    assert.equal(config.serverUrl.get(), saved.serverUrl);
    assert.equal(config.name.get(), saved.name);
    assert.equal(config.instanceId.get(), saved.instanceId);
    assert.equal(config.pairingCode.get(), "");
    assert.equal(pairingCodeSet, false);
    assert.equal(tunnels[0].options.agentId, saved.agentId);
    assert.equal(tunnels[0].options.agentToken, saved.agentToken);

    current.serverUrl = "http://new-manager:10090";
    user = { ...user, serverUrl: current.serverUrl };
    settingsRevision++;
    listeners.get("settings/document-updated")(
      DSH_MANAGER_SETTINGS_ENTRY_ID,
      settingsRevision,
    );
    await pauseForSync();
    assert.equal(tunnels.length, 2);
    assert.equal(tunnels[0].closed, true);
    assert.equal(tunnels[1].options.serverUrl, current.serverUrl);
    assert.equal(tunnels[1].options.agentId, "");
    assert.equal(tunnels[1].options.agentToken, "");
    assert.equal(tunnels[1].options.allowEnrollment, true);
    let persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(persisted.agentId, saved.agentId);
    assert.equal(persisted.agentToken, saved.agentToken);

    current.pairingCode = "new-pairing";
    settingsRevision++;
    listeners.get("settings/document-updated")(
      DSH_MANAGER_SETTINGS_ENTRY_ID,
      settingsRevision,
    );
    await pauseForSync();
    assert.equal(tunnels.length, 3);
    assert.equal(tunnels[1].closed, true);
    assert.equal(tunnels[2].options.serverUrl, current.serverUrl);
    assert.equal(tunnels[2].options.agentId, saved.agentId);
    assert.equal(tunnels[2].options.agentToken, saved.agentToken);
    assert.equal(tunnels[2].options.allowEnrollment, true);
    persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(persisted.agentId, saved.agentId);
    assert.equal(persisted.agentToken, saved.agentToken);
  } finally {
    dispose?.();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
