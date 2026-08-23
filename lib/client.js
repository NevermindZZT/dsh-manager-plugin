window.__ModuleLoader__.load({
  id: "@nevermindzzt/dsh-manager-plugin",
  factory: (require) => {
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { useEffect, useState } = require("react");
    const { IconChevronDownOutline14 } = require("@deepseek-ai/dsh-client-ui-primitives");
    const module = { exports: {} };
    const exports = module.exports;
    const CSS = `
    .dsh-manager-card { list-style: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-3); transition: border-color .16s, background .16s; }
    .dsh-manager-card:hover { border-color: var(--dsw-alias-label-dimmed); }
    .dsh-manager-card-open { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-label-dimmed); }
    .dsh-manager-card-header { width: 100%; appearance: none; border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-radius: 12px; }
    .dsh-manager-card-header:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
    .dsh-manager-card-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .dsh-manager-card-name { font-size: 15px; font-weight: 600; line-height: 1.4; color: var(--dsw-alias-label-primary); }
    .dsh-manager-card-description { font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
    .dsh-manager-card-chevron { flex: none; color: var(--dsw-alias-label-tertiary); transition: transform .16s; }
    .dsh-manager-card-chevron-open { transform: rotate(180deg); }
    .dsh-manager-card-pending { flex: none; border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
    .dsh-manager-card-body { border-top: 1px solid var(--dsw-alias-border-l2); margin: 0 16px; padding: 12px 0 8px; }
    .dsh-manager-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; margin: 10px 0; }
    .dsh-manager-field-label { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
    .dsh-manager-input { width: 100%; box-sizing: border-box; min-height: 32px; padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }
    .dsh-manager-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
    .dsh-manager-checkbox { width: 16px; height: 16px; accent-color: var(--dsw-alias-brand-primary); }
    .dsh-manager-field-inline { flex-direction: row; align-items: center; gap: 8px; }
    .dsh-manager-card-failed { margin: 0 0 10px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-error); }
    .dsh-manager-card-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 0 4px; border-top: 1px solid var(--dsw-alias-border-l2); }
    .dsh-manager-card-discard, .dsh-manager-card-save { appearance: none; border: 1px solid transparent; border-radius: 8px; padding: 5px 14px; font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer; }
    .dsh-manager-card-discard { border-color: var(--dsw-alias-border-l2); background: none; color: var(--dsw-alias-label-secondary); }
    .dsh-manager-card-discard:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }
    .dsh-manager-card-save { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
    .dsh-manager-card-save:disabled, .dsh-manager-card-discard:disabled { opacity: .4; cursor: default; }
    .dsh-manager-card-save:focus-visible, .dsh-manager-card-discard:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
    `;
    function adoptStyles() {
      if (typeof document === "undefined") return;
      const id = "@nevermindzzt/dsh-manager-plugin/settings-card";
      if (document.querySelector('style[data-plugin-css="' + id + '"]')) return;
      const style = document.createElement("style");
      style.dataset.plugin = "@nevermindzzt/dsh-manager-plugin";
      style.dataset.pluginCss = id;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    
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
      ["pairingCode", "配对码"],
      ["name", "Agent 名称"],
      ["instanceId", "实例 ID"],
      ["tlsFingerprint", "TLS 指纹"],
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
    
    exports.inject = ["slots", "settingsScope"];
    exports.apply = function apply(ctx) {
      adoptStyles();
      const scope = ctx.settingsScope.bind({ namespace: NS });
      ctx.slots.inject("settings.plugin.item", () =>
        ctx.slots.register(
          { name: "settings.plugin.item", key: NS, inject: () => ({ scope }) },
          ManagerSettingsCard,
        ),
      );
    }
    return module.exports;
  }
});
