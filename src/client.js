import { jsx, jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { IconChevronDownOutline14 } from "@deepseek-ai/dsh-client-ui-primitives";
import { adoptStyles } from "./styles.js";

const NS = "dsh-manager";

function validateServerUrl(value) {
  try {
    const url = new URL(value);
    const httpsPorts = new Set(["443", "8443", "18443", "19443", "10091"]);
    const httpPorts = new Set(["80", "8080", "18080", "19080", "10090"]);
    if (url.protocol === "http:" && httpsPorts.has(url.port))
      return "当前端口是 HTTPS/WSS 端口，请将 URL 改为 https://";
    if (url.protocol === "https:" && httpPorts.has(url.port))
      return "当前端口是 HTTP 端口，请改用 http:// 或填写 Agent HTTPS 端口";
    return "";
  } catch {
    return "请输入有效的 Manager URL";
  }
}

const FIELDS = [
  ["serverUrl", "Manager URL"],
  ["pairingCode", "首次配对码（仅注册时使用）"],
  ["name", "Agent 名称"],
  ["instanceId", "实例 ID"],
  ["tlsFingerprint", "TLS 指纹（可选；公共 CA 可留空）"],
];

function valueOf(snapshot) {
  const value = snapshot.value || {};
  return {
    enabled: value.enabled !== false,
    serverUrl: String(value.serverUrl || ""),
    pairingCode: String(value.pairingCode || ""),
    name: String(value.name || "dsh-plugin"),
    instanceId: String(value.instanceId || "default"),
    tlsFingerprint: String(value.tlsFingerprint || ""),
  };
}

function ManagerSettingsCard({ scope }) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState(() => scope.getSnapshot());
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(
    () => scope.subscribe(() => setSnapshot(scope.getSnapshot())),
    [scope],
  );
  if (snapshot.status !== "ready") return null;

  const base = valueOf(snapshot);
  const current = draft || base;
  const dirty = draft !== null;
  const edit = (field, value) => {
    setError("");
    setDraft({ ...current, [field]: value });
  };
  const save = async () => {
    if (!dirty || saving || !snapshot.writable) return;
    setSaving(true);
    setError("");
    const validationError = validateServerUrl(current.serverUrl);
    if (validationError) {
      setError(validationError);
      return;
    }
    const normalizedFingerprint = String(current.tlsFingerprint || "")
      .replace(/[\s:.-]/g, "")
      .toUpperCase();
    if (
      normalizedFingerprint &&
      !/^[A-F0-9]{64}$/.test(normalizedFingerprint)
    ) {
      setError("TLS 指纹必须是 64 位 SHA-256，或留空以信任公共 CA");
      return;
    }
    try {
      for (const [field, value] of Object.entries(current))
        await scope.set(field, value);
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    setDraft(null);
    setError("");
  };
  const cardClass = open
    ? "dsh-manager-card dsh-manager-card-open"
    : "dsh-manager-card";
  const chevronClass = open
    ? "dsh-manager-card-chevron dsh-manager-card-chevron-open"
    : "dsh-manager-card-chevron";

  return jsxs("li", {
    className: cardClass,
    children: [
      jsxs("button", {
        type: "button",
        className: "dsh-manager-card-header",
        "aria-expanded": open,
        onClick: () => setOpen(!open),
        children: [
          jsxs("span", {
            className: "dsh-manager-card-head-text",
            children: [
              jsx("span", {
                className: "dsh-manager-card-name",
                children: "dsh-manager",
              }),
              jsx("span", {
                className: "dsh-manager-card-description",
                children: "配置 dsh 直连 manager",
              }),
            ],
          }),
          dirty
            ? jsx("span", {
                className: "dsh-manager-card-pending",
                children: "未保存",
              })
            : null,
          jsx(IconChevronDownOutline14, { className: chevronClass }),
        ],
      }),
      open
        ? jsxs("div", {
            className: "dsh-manager-card-body",
            children: [
              jsx("label", {
                className: "dsh-manager-field dsh-manager-field-inline",
                children: [
                  jsx("input", {
                    className: "dsh-manager-checkbox",
                    type: "checkbox",
                    checked: current.enabled,
                    onChange: (event) => edit("enabled", event.target.checked),
                  }),
                  jsx("span", {
                    className: "dsh-manager-field-label",
                    children: "启用 dsh-manager 直连",
                  }),
                ],
              }),
              ...FIELDS.map(([field, label]) =>
                jsx(
                  "label",
                  {
                    className: "dsh-manager-field",
                    children: [
                      jsx("span", {
                        className: "dsh-manager-field-label",
                        children: label,
                      }),
                      jsx("input", {
                        className: "dsh-manager-input",
                        type:
                          field === "pairingCode" || field === "tlsFingerprint"
                            ? "password"
                            : "text",
                        value: current[field],
                        onChange: (event) => edit(field, event.target.value),
                      }),
                    ],
                  },
                  field,
                ),
              ),
              error
                ? jsx("p", {
                    className: "dsh-manager-card-failed",
                    role: "status",
                    children: error,
                  })
                : null,
              jsxs("div", {
                className: "dsh-manager-card-footer",
                children: [
                  jsx("button", {
                    type: "button",
                    className: "dsh-manager-card-discard",
                    disabled: !dirty || saving,
                    onClick: discard,
                    children: "放弃修改",
                  }),
                  jsx("button", {
                    type: "button",
                    className: "dsh-manager-card-save",
                    disabled: !dirty || saving || !snapshot.writable,
                    onClick: () => void save(),
                    children: saving ? "保存中…" : "保存",
                  }),
                ],
              }),
            ],
          })
        : null,
    ],
  });
}

export const inject = ["slots", "settingsScope"];
export function apply(ctx) {
  adoptStyles();
  const scope = ctx.settingsScope.bind({ namespace: NS });
  ctx.slots.inject("settings.plugin.item", () =>
    ctx.slots.register(
      { name: "settings.plugin.item", key: NS, inject: () => ({ scope }) },
      ManagerSettingsCard,
    ),
  );
}
