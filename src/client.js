import { jsx, jsxs } from "react/jsx-runtime";
import * as primitives from "@deepseek-ai/dsh-client-ui-primitives";

const ENTRY_ID = "dsh-manager-plugin";
const BUNDLE_ID = "@nevermindzzt/dsh-manager-plugin";
const ENTRY_IDS = [ENTRY_ID, BUNDLE_ID];
export const name = BUNDLE_ID;
export const inject = ["slots"];
const isChinese =
  typeof navigator !== "undefined" &&
  String(navigator.language || "")
    .toLowerCase()
    .startsWith("zh");
const labels = isChinese
  ? {
      unavailable: "当前 profile 未提供此插件的设置项。",
      readOnly: "当前设置文档为只读。",
      saveFailed: "保存失败，请检查连接后重试。",
      save: "保存",
      saving: "保存中…",
      overridden: "已自定义",
      reset: "恢复默认",
      invalid: "输入无效",
      managerSection: "dsh-manager 隧道",
      managerEnabled: "启用 dsh-manager 连接",
      managerEnabledHint: "关闭后停止隧道，但保留本地 Agent 状态。",
      managerUrl: "Manager URL",
      managerUrlHint: "支持 HTTP/HTTPS；清空覆盖后使用已有环境变量或本地配置。",
      managerUrlPlaceholder: "http://manager:10090",
      pairingCode: "首次配对码",
      pairingCodeHint: "仅首次注册或重新配对时填写；留空保持当前配对码。",
      pairingConfigured: "已设置",
      pairingMissing: "未设置",
      agentName: "Agent 名称",
      agentNameHint: "显示在 dsh-manager 上的 Agent 名称。",
      agentNamePlaceholder: "dsh-plugin",
      instanceId: "实例 ID",
      instanceIdHint: "同一 Manager 下区分多个 DSH 实例。",
      instanceIdPlaceholder: "default",
      directSection: "局域网直连",
      directEnabled: "启用直接访问端口",
      directEnabledHint: "无需 dsh-manager；其他设备直接连接此 DSH Web。",
      directHost: "监听地址",
      directHostHint:
        "使用 127.0.0.1 仅本机访问；使用 0.0.0.0 允许 IPv4 网卡访问。未设置密码时，任何可达设备都能使用完整 DSH Web。",
      directHostPlaceholder: "127.0.0.1 或 0.0.0.0",
      directPort: "监听端口",
      directPortHint: "其他设备访问 http://此电脑的局域网 IP:端口。",
      directPassword: "直连访问密码",
      directPasswordHint:
        "密码可选；如设置至少 8 位。留空保持已保存密码，可用下方按钮清除。",
      directPasswordClear: "清除已保存密码（恢复无密码访问）",
      directPasswordConfigured: "已设置",
      directPasswordMissing: "未设置",
      directWarning:
        "注意：HTTP 不加密密码、Cookie 或对话内容。无密码时任何可达设备都可使用完整 DSH Web。仅用于可信局域网；不要直接映射到公网。",
    }
  : {
      unavailable: "This profile does not provide settings for this plugin.",
      readOnly: "The current settings document is read-only.",
      saveFailed: "Save failed. Check the connection and try again.",
      save: "Save",
      saving: "Saving…",
      overridden: "Customized",
      reset: "Reset to default",
      invalid: "Invalid input",
      managerSection: "dsh-manager tunnel",
      managerEnabled: "Enable dsh-manager connection",
      managerEnabledHint:
        "Stops the tunnel when disabled; local Agent state is retained.",
      managerUrl: "Manager URL",
      managerUrlHint:
        "HTTP/HTTPS. Clear the override to use the existing environment or local setting.",
      managerUrlPlaceholder: "http://manager:10090",
      pairingCode: "Initial pairing code",
      pairingCodeHint:
        "Only needed for first registration or re-pairing; blank keeps the current code.",
      pairingConfigured: "Configured",
      pairingMissing: "Not set",
      agentName: "Agent name",
      agentNameHint: "Name displayed in dsh-manager.",
      agentNamePlaceholder: "dsh-plugin",
      instanceId: "Instance ID",
      instanceIdHint: "Distinguishes multiple DSH instances under one Manager.",
      instanceIdPlaceholder: "default",
      directSection: "Direct LAN access",
      directEnabled: "Enable direct access port",
      directEnabledHint:
        "Does not require dsh-manager; other devices connect directly to this DSH Web instance.",
      directHost: "Listen address",
      directHostHint:
        "Use 127.0.0.1 for this computer only or 0.0.0.0 for IPv4 interfaces. Without a password, any reachable device gets full DSH Web access.",
      directHostPlaceholder: "127.0.0.1 or 0.0.0.0",
      directPort: "Listen port",
      directPortHint:
        "Other devices connect to http://this-computer-LAN-IP:port.",
      directPassword: "Direct access password",
      directPasswordHint:
        "Optional; if set, use at least 8 characters. Blank keeps the saved password; use the button below to clear it.",
      directPasswordClear:
        "Clear saved password (allow unauthenticated access)",
      directPasswordConfigured: "Configured",
      directPasswordMissing: "Not set",
      directWarning:
        "HTTP does not encrypt passwords, cookies, or conversations. Without a password, any reachable device gets full DSH Web access. Use only on a trusted LAN; do not expose this port directly to the internet.",
    };

const enabledField = {
  field: "enabled",
  format: (value) => (value === false ? "false" : "true"),
  parse: (text) =>
    text === "true" || text === "false"
      ? { kind: "set", value: text === "true" }
      : undefined,
};
const directAccessEnabledField = {
  field: "directAccessEnabled",
  format: (value) => (value === true ? "true" : "false"),
  parse: (text) =>
    text === "true" || text === "false"
      ? { kind: "set", value: text === "true" }
      : undefined,
};
const managerUrlField = {
  field: "serverUrl",
  format: (value) => String(value ?? ""),
  parse: (text) => {
    const value = text.trim();
    if (value === "") return { kind: "clear" };
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        return undefined;
      return { kind: "set", value };
    } catch {
      return undefined;
    }
  },
};
const directAccessHostField = {
  field: "directAccessHost",
  format: (value) => String(value ?? "127.0.0.1"),
  parse: (text) => {
    const value = text.trim();
    if (/^[a-fA-F0-9:.]+$/.test(value)) return { kind: "set", value };
    return undefined;
  },
};
const directAccessPortField = {
  field: "directAccessPort",
  format: (value) => String(value ?? 3081),
  parse: (text) => {
    const value = Number(text.trim());
    return Number.isSafeInteger(value) && value >= 1 && value <= 65535
      ? { kind: "set", value }
      : undefined;
  },
};
const fieldSpecs = [
  enabledField,
  managerUrlField,
  primitives.settingsTextField("name"),
  primitives.settingsTextField("instanceId"),
  directAccessEnabledField,
  directAccessHostField,
  directAccessPortField,
];
const secretSpecs = (scope) => [
  {
    field: "pairingCode",
    write: (value) => scope.set("pairingCode", value),
  },
  {
    field: "directAccessPassword",
    write: (value) => scope.set("directAccessPassword", value),
  },
];

function secretIsConfigured(describeFace, entryId, field) {
  const view = describeFace.getSnapshot().view;
  const namespace = view?.namespaces?.find((entry) => entry.ns === entryId);
  return Boolean(
    namespace?.secrets?.some(
      (secret) =>
        secret.path.length === 1 && secret.path[0] === field && secret.set,
    ),
  );
}

function buildFormState(model, describeFace, entryId) {
  return {
    shell: model.shell(),
    enabled: model.field("enabled"),
    serverUrl: model.field("serverUrl"),
    pairingCode: model.field("pairingCode"),
    name: model.field("name"),
    instanceId: model.field("instanceId"),
    directAccessEnabled: model.field("directAccessEnabled"),
    directAccessHost: model.field("directAccessHost"),
    directAccessPort: model.field("directAccessPort"),
    directAccessPassword: model.field("directAccessPassword"),
    pairingCodeConfigured: secretIsConfigured(
      describeFace,
      entryId,
      "pairingCode",
    ),
    directAccessPasswordConfigured: secretIsConfigured(
      describeFace,
      entryId,
      "directAccessPassword",
    ),
  };
}

function ManagerSettingsCard(props) {
  const state =
    typeof props.useManagerSettings === "function"
      ? props.useManagerSettings((snapshot) => snapshot)
      : undefined;
  if (state === undefined) return null;

  const disabled =
    !state.shell.available || !state.shell.writable || state.shell.saving;
  const valueField = (field, label, hint, placeholder) =>
    jsx(primitives.SettingsValueField, {
      id: "dsh-manager-" + field,
      label,
      hint,
      text: state[field].text,
      overridden: state[field].overridden,
      invalid: state[field].invalid,
      overriddenLabel: labels.overridden,
      resetLabel: labels.reset,
      invalidLabel: labels.invalid,
      disabled,
      placeholder,
      onEdit: (value) => props.edit(field, value),
      onReset: () => props.resetField(field),
    });
  const secretField = (
    field,
    id,
    label,
    hint,
    configured,
    configuredLabel,
    missingLabel,
  ) =>
    jsx(primitives.SettingsSecretField, {
      id,
      label,
      hint,
      text: state[field].text,
      configured,
      stateLabel: configured ? configuredLabel : missingLabel,
      disabled,
      onEdit: (value) => props.edit(field, value),
    });

  return jsx(primitives.SettingsForm, {
    labels,
    state: state.shell,
    onSave: props.save,
    onDiscard: props.discard,
    children: jsxs("div", {
      className: "dsh-manager-settings-fields",
      children: [
        jsx("h3", { children: labels.managerSection }),
        jsx(primitives.Switch, {
          checked: state.enabled.text === "true",
          onChange: (enabled) => props.edit("enabled", String(enabled)),
          label: labels.managerEnabled,
          title: labels.managerEnabledHint,
          disabled,
        }),
        valueField(
          "serverUrl",
          labels.managerUrl,
          labels.managerUrlHint,
          labels.managerUrlPlaceholder,
        ),
        secretField(
          "pairingCode",
          "dsh-manager-pairingCode",
          labels.pairingCode,
          labels.pairingCodeHint,
          state.pairingCodeConfigured,
          labels.pairingConfigured,
          labels.pairingMissing,
        ),
        valueField(
          "name",
          labels.agentName,
          labels.agentNameHint,
          labels.agentNamePlaceholder,
        ),
        valueField(
          "instanceId",
          labels.instanceId,
          labels.instanceIdHint,
          labels.instanceIdPlaceholder,
        ),
        jsx("h3", { children: labels.directSection }),
        jsx(primitives.Switch, {
          checked: state.directAccessEnabled.text === "true",
          onChange: (enabled) =>
            props.edit("directAccessEnabled", String(enabled)),
          label: labels.directEnabled,
          title: labels.directEnabledHint,
          disabled,
        }),
        valueField(
          "directAccessHost",
          labels.directHost,
          labels.directHostHint,
          labels.directHostPlaceholder,
        ),
        valueField(
          "directAccessPort",
          labels.directPort,
          labels.directPortHint,
          "3081",
        ),
        secretField(
          "directAccessPassword",
          "dsh-manager-directAccessPassword",
          labels.directPassword,
          labels.directPasswordHint,
          state.directAccessPasswordConfigured,
          labels.directPasswordConfigured,
          labels.directPasswordMissing,
        ),
        state.directAccessPasswordConfigured
          ? jsx(primitives.Button, {
              type: "button",
              size: "sm",
              variant: "ghost",
              className: "dsh-manager-clear-direct-password",
              disabled,
              onClick: props.clearDirectAccessPassword,
              children: labels.directPasswordClear,
            })
          : null,
        jsx("p", {
          className: "dsh-manager-direct-warning",
          children: labels.directWarning,
        }),
      ],
    }),
  });
}

export function apply(ctx) {
  ctx.inject(["configForms"], (client) => {
    const forms = client.configForms;
    if (
      forms === undefined ||
      typeof forms.get !== "function" ||
      typeof forms.describe !== "function" ||
      typeof forms.whileServed !== "function"
    )
      return;

    const describeFace = forms.describe();
    client.effect(
      () =>
        forms.whileServed(ENTRY_IDS, (served) => {
          const entryId = ENTRY_IDS.find((candidate) => served.has(candidate));
          if (entryId === undefined) return () => {};

          const scope = forms.get(entryId);
          const model = new primitives.SettingsFormModel(
            scope,
            fieldSpecs,
            secretSpecs(scope),
          );
          const store = model.bind(() =>
            buildFormState(model, describeFace, entryId),
          );
          const actions = model.actions();
          const clearDirectAccessPassword = () =>
            typeof scope.mutate === "function"
              ? scope.mutate([
                  {
                    op: "unset",
                    path: ["directAccessPassword"],
                  },
                ])
              : Promise.resolve(false);
          const injectForm = () => ({
            hooks: { managerSettings: store },
            edit: actions.edit,
            resetField: actions.resetField,
            save: actions.save,
            discard: actions.discard,
            clearDirectAccessPassword,
          });
          const disposeSlot = client.slots.inject("plugins.bundle.config", () =>
            client.slots.register(
              {
                name: "plugins.bundle.config",
                key: BUNDLE_ID,
                inject: injectForm,
              },
              ManagerSettingsCard,
            ),
          );
          return () => {
            disposeSlot();
            model.dispose();
          };
        }),
      "dsh-manager-plugin config form",
    );
  });
}
