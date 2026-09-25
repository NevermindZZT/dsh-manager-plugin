window.__ModuleLoader__.load({
  id: "@nevermindzzt/dsh-manager-plugin",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const { jsx, jsxs } = require("react/jsx-runtime");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const ENTRY_ID = "dsh-manager-plugin";
    const BUNDLE_ID = "@nevermindzzt/dsh-manager-plugin";
    const ENTRY_IDS = [ENTRY_ID, BUNDLE_ID];
    exports.name = BUNDLE_ID;
    exports.inject = ["slots"];
    const labels = {
      unavailable: "当前 profile 未提供此插件的设置项。",
      readOnly: "当前设置文档为只读。",
      saveFailed: "保存失败，请检查连接后重试。",
      save: "保存",
      saving: "保存中…",
    };

    const enabledField = {
      field: "enabled",
      format: (value) => (value === false ? "false" : "true"),
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
    const fieldSpecs = [
      enabledField,
      managerUrlField,
      primitives.settingsTextField("name"),
      primitives.settingsTextField("instanceId"),
    ];
    const secretSpecs = (scope) => [
      {
        field: "pairingCode",
        write: (value) => scope.set("pairingCode", value),
      },
    ];

    function pairingCodeIsConfigured(describeFace, entryId) {
      const view = describeFace.getSnapshot().view;
      const namespace = view?.namespaces?.find((entry) => entry.ns === entryId);
      return Boolean(
        namespace?.secrets?.some(
          (secret) =>
            secret.path.length === 1 &&
            secret.path[0] === "pairingCode" &&
            secret.set,
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
        pairingCodeConfigured: pairingCodeIsConfigured(describeFace, entryId),
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
          overriddenLabel: "已自定义",
          resetLabel: "恢复默认",
          invalidLabel: "输入无效",
          disabled,
          placeholder,
          onEdit: (value) => props.edit(field, value),
          onReset: () => props.resetField(field),
        });

      return jsx(primitives.SettingsForm, {
        labels,
        state: state.shell,
        onSave: props.save,
        onDiscard: props.discard,
        children: jsxs("div", {
          className: "dsh-manager-settings-fields",
          children: [
            jsx(primitives.Switch, {
              checked: state.enabled.text === "true",
              onChange: (enabled) => props.edit("enabled", String(enabled)),
              label: "启用 dsh-manager 连接",
              title: "关闭后停止隧道，但保留本地 Agent 状态。",
              disabled,
            }),
            valueField(
              "serverUrl",
              "Manager URL",
              "支持 HTTP/HTTPS；清空覆盖后使用已有环境变量或本地配置。",
              "http://manager:10090",
            ),
            jsx(primitives.SettingsSecretField, {
              id: "dsh-manager-pairingCode",
              label: "首次配对码",
              hint: "仅首次注册或重新配对时填写；留空保持当前配对码。",
              text: state.pairingCode.text,
              configured: state.pairingCodeConfigured,
              stateLabel: state.pairingCodeConfigured ? "已设置" : "未设置",
              disabled,
              onEdit: (value) => props.edit("pairingCode", value),
            }),
            valueField(
              "name",
              "Agent 名称",
              "显示在 dsh-manager 上的 Agent 名称。",
              "dsh-plugin",
            ),
            valueField(
              "instanceId",
              "实例 ID",
              "同一 Manager 下区分多个 DSH 实例。",
              "default",
            ),
          ],
        }),
      });
    }

    exports.apply = function apply(ctx) {
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
              const entryId = ENTRY_IDS.find((candidate) =>
                served.has(candidate),
              );
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
              const injectForm = () => ({
                hooks: { managerSettings: store },
                edit: actions.edit,
                resetField: actions.resetField,
                save: actions.save,
                discard: actions.discard,
              });
              const disposeSlot = client.slots.inject(
                "plugins.bundle.config",
                () =>
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
    };

    return module.exports;
  },
});
