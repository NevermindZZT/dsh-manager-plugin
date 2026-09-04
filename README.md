# @nevermindzzt/dsh-manager-plugin

![Version](https://img.shields.io/badge/version-v0.1.7-blue)
[![npm](https://img.shields.io/npm/v/@nevermindzzt/dsh-manager-plugin?logo=npm)](https://www.npmjs.com/package/@nevermindzzt/dsh-manager-plugin)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933)
![Protocol](https://img.shields.io/badge/dsh--manager%20Protocol-v1-6f42c1)
![Module](https://img.shields.io/badge/dsh%20Client%20Module-Web-5b8cff)
![License](https://img.shields.io/badge/license-MIT-green)

在 dsh 进程内建立 dsh-manager 反向连接的插件。安装后不需要 dsh-launcher，也可以将当前 dsh 实例注册到 dsh-manager，并通过 manager 访问 dsh Web UI。

## 版本

当前版本：

    0.1.7

协议保持：

    dsh-manager Agent Protocol v1

插件使用可选的 Agent 元数据字段，不改变已有 dsh-launcher 的连接方式。

## 架构

    浏览器
        ↓ HTTP / WebSocket
    dsh-manager
        ↓ HTTP / WS 或 HTTPS / WSS
    dsh-manager-plugin
        ↓ 127.0.0.1:<dsh-web-port>
    当前 dsh 实例

插件只能代理当前 dsh 实例，不提供任意 shell，也不提供 dsh-launcher 的启动、停止、重启、同步和更新能力。

## 能力

- 使用首次配对码完成一次性注册；后续连接只使用 Agent Token；
- HTTP / HTTPS enrollment；
- WS / WSS Agent 长连接；
- HTTP 请求反向代理；
- WebSocket 双向代理；
- settings.host Host settings 能力声明；
- dsh 设置页面中的 manager 配置卡片；
- Agent Token 本地持久化；
- 旧版 dsh-manager Agent Protocol v1 兼容；
- HTTP / HTTPS 端口配置校验；
- 旧 Agent Token 收到 401/403 后清除本地凭证，输入新的配对码后重新注册；
- 不支持任意 shell 和远程生命周期命令。

## 安装

插件发布到 npm 后，可以直接通过 dsh profile 安装：

    dsh plugin --profile web add @nevermindzzt/dsh-manager-plugin

也可以使用 npm 安装到 dsh profile：

    cd %USERPROFILE%\.dsh\profiles\web
    npm install @nevermindzzt/dsh-manager-plugin

本地 tarball 安装：

    dsh plugin --profile web add nevermindzzt-dsh-manager-plugin-0.1.7.tgz

安装后重启 dsh：

    dsh web

插件会作为 dsh Web bundle 加载，并注册到 settings.plugin.item。

## dsh 设置

进入：

    设置 → 插件 → 插件配置 → dsh-manager

配置项：

- 启用 dsh-manager 直连；
- Manager URL；
- 首次配对码（仅注册时使用）；
- Agent 名称；
- 实例 ID；
- TLS 指纹（可选；公共 CA 证书可留空）。

设置卡片默认折叠，使用 dsh 原生 CSS 变量和插件卡片交互样式。保存后插件会重新建立连接；如果没有配置 Manager URL，插件只注册设置项并保持禁用，不会阻塞 dsh web 启动。

## Manager URL

HTTP / WS（仅可信内网）：

    http://manager.example.com:8080

HTTPS / WSS（推荐）：

    https://manager.example.com:8443

不能把 HTTP 和 HTTPS 端口混用：

    错误：http://manager.example.com:8443
    正确：https://manager.example.com:8443

HTTPS 模式下，TLS 指纹是可选的：留空时使用 Node.js 系统公共 CA 和主机名校验，适用于 Cloudflare Tunnel / Let's Encrypt 等公共证书；填写 64 位 SHA-256 指纹时则固定到该证书，适用于自签名 manager。配对码只在首次注册或明确重新注册时使用；manager 刷新配对码、重启生成新配对码，都不会影响已有 Agent Token 的连接。只有 Agent Token 失效或 manager 更换数据库后，插件才会清理旧凭证并等待用户输入新的配对码。

## 环境变量

如果不想通过 dsh 设置，也可以使用环境变量：

    DSH_MANAGER_URL=https://manager.example.com:8443
    DSH_MANAGER_PAIRING_CODE=one-time-code
    DSH_MANAGER_NAME=linux-dsh
    DSH_MANAGER_INSTANCE_ID=default
    DSH_MANAGER_TLS_FINGERPRINT=sha256-fingerprint  # 可选；公共 CA 可留空

环境变量适合容器或自动化部署。未配置 DSH_MANAGER_URL 时插件保持禁用。

## Cordis 加载

插件也可以作为 Cordis plugin 加载：

    import dshManagerPlugin from "@nevermindzzt/dsh-manager-plugin";

    export default {
      plugins: [
        [dshManagerPlugin, {
          serverUrl: "https://manager.example.com:8443",
          pairingCode: "one-time-code",
          name: "linux-dsh",
          instanceId: "default"
        }]
      ]
    };

## 本地凭证

默认状态文件：

    ~/.dsh/manager-agent.json

保存内容包括：

- Agent ID；
- Agent Token；
- manager URL；
- Agent 名称；
- 实例 ID；
- TLS 指纹。

Linux 下插件会尝试使用 0700 目录和 0600 文件权限保存状态。

## 安全边界

- 生产环境推荐 HTTPS / WSS；
- Agent Token 不提交到 Git；
- manager 只保存 Token Hash；
- 插件只代理当前 dsh Web 服务；
- 不接受 manager 下发任意 shell；
- 不提供宿主机任意端口或文件访问；
- 一个 Agent ID 应只对应一个活动 dsh 进程；
- 多个 dsh 进程共用同一个 Agent Token 时，manager 会用新连接替换旧连接。

## 开发

安装依赖：

    npm install

格式化：

    npx prettier --write src/*.js lib/*.js

语法检查：

    node --check src/index.js
    node --check src/protocol.js
    node --check src/tunnel.js
    node --check src/client.js
    node --check lib/client.js

构建本地 tarball：

    npm pack

当前仓库包含：

- Host 端 Cordis plugin；
- Web Client ModuleLoader bundle；
- HTTP / WebSocket tunnel；
- dsh settings namespace；
- dsh settings plugin card；
- dsh bundle patch。

## 发布

GitHub Actions 会在推送 vX.Y.Z 标签时自动执行：

1. 安装依赖；
2. 运行 npm run check；
3. 构建 Web Client ModuleLoader bundle；
4. 发布到 npm。

需要在 GitHub 仓库 Secrets 中配置：

    NPM_TOKEN

本地发布前验证：

    npm ci
    npm run check
    npm publish --access public

## 相关项目

- [dsh-manager](https://github.com/NevermindZZT/dsh-manager)
- [dsh-launcher](https://github.com/NevermindZZT/dsh-launcher)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

## 开源协议

[MIT](LICENSE)
