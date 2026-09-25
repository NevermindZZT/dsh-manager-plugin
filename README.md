# @nevermindzzt/dsh-manager-plugin

![Version](https://img.shields.io/badge/version-v0.2.3-blue)
![Protocol](https://img.shields.io/badge/dsh--manager%20Protocol-v1-6f42c1)
![License](https://img.shields.io/badge/license-MIT-green)

本版本适配 DSH `0.1.7-rc.2`：插件以命名导出 `name`、`Config`、`inject`、`apply`，使 DSH loader 的 module namespace 保留 Config schema；client 端通过 `configForms.get/whileServed` 和 `plugins.bundle.config` slot 渲染 RC2 设置卡片。未被 DSH user layer 覆盖的 Manager URL、Agent 名称和实例 ID 会显示当前 environment/local-state 有效值；显式 DSH user overrides 优先。字段使用 volatile schema，`pairingCode` 使用 `secret` role 并以 write-only 控件保存。Host-side `describe({ redactSecrets: true })` 只把非敏感 user overrides 交给隧道配置解析；配对码仅从 volatile Config/受保护的本地状态读取，不放入 descriptor user data。settings 更新按 `settings/document-updated(ns, revision)` 处理并忽略重复或过期 revision；不再使用旧 `settingsScope` / `settings.plugin.item` API。DSH 插件列表显示名称来自 `locale/<lang>.json` 的 `meta.title`，图标来自 `package.json` 的相对 `icon` 文件；`dsh.patch.yml` 中的 `name` 仍保留为实际模块 specifier。

## 0.2.3 transport and relay optimization

- 移除私有证书、TLS fingerprint 和证书 pinning；
- manager 使用单一 HTTP upstream 端口；
- 可信内网可直接使用 `http://manager:port`；
- 公网 HTTPS/WSS 由 Cloudflare Tunnel 或其他反向代理终止，manager upstream 仍使用 HTTP；
- DSH Web startup URL 只在内存中保存，绝不写入 plugin state 或日志；Manager transport 仅记录 origin，不记录 URL userinfo、path、query 或 fragment；
- 首个 manager 标记的根请求使用 startup token，随后通过 Cookie 使用干净 URL；
- WebSocket tunnel 会转发浏览器 Cookie；
- 对浏览器支持 gzip 的请求保留 DSH gzip 响应，避免在 Agent WebSocket 上传输未压缩静态资源；
- 与支持 `proxy.binary-response-v1` 的 manager 使用二进制响应帧，避免 HTTP 响应 body 再次 Base64 编码。

## 架构

```text
浏览器
  ↓ HTTP / WebSocket（或外部代理终止后的 HTTPS / WSS）
dsh-manager 单一 HTTP 端口
  ↓ HTTP / WS Agent Protocol v1
dsh-manager-plugin
  ↓ 本地 dsh HTTP / WebSocket
当前 dsh 实例
```

插件只能代理当前 dsh 实例，不提供任意 shell 或 launcher 生命周期命令。

## 能力

- 使用首次配对码完成一次性注册；后续连接只使用 Agent Token；
- HTTP/HTTPS enrollment（HTTPS 由外部代理提供）；
- WS/WSS Agent 长连接（WSS 由外部代理提供）；
- HTTP 请求反向代理；
- WebSocket 双向代理；
- settings.host、plugin.config、`dsh.web.bootstrap-v1` 和 `proxy.binary-response-v1` 能力声明；
- Agent Token 本地持久化；
- pairing code 刷新不会使已有 Agent Token 失效；
- 不支持任意 shell 和远程生命周期命令。

## 安装

```powershell
dsh plugin --profile web add @nevermindzzt/dsh-manager-plugin@0.2.3
```

安装后重启 dsh：

```powershell
dsh web
```

## dsh 设置

进入：

```text
设置 → 插件 → dsh-manager-plugin → 配置
```

原生配置表单提供启用开关、Manager URL、首次配对码、Agent 名称和实例 ID；首次配对码为 secret/write-only 字段。空 Config 字段继续回退到现有 `~/.dsh/manager-agent.json`，显式设置的 Config 值优先。RC2 的 `settings/document-updated(ns, revision)` 会刷新本插件设置并重建隧道；重复或过期 revision 不会重复重建。更换配对码不会清除已有 Agent Token。没有 TLS fingerprint 配置项。

## Manager URL

可信内网：

```text
http://manager.example.com:10090
```

通过 HTTPS 反向代理：

```text
https://manager.example.com
```

HTTPS 由 Node.js 系统 CA 校验；插件不接受私有证书 fingerprint，也不会关闭证书校验。

## 环境变量

```text
DSH_MANAGER_URL=http://manager.example.com:10090
DSH_MANAGER_PAIRING_CODE=one-time-code
DSH_MANAGER_NAME=linux-dsh
DSH_MANAGER_INSTANCE_ID=default
```

未配置 `DSH_MANAGER_URL` 时插件保持禁用。

## 本地凭证

默认状态文件：

```text
~/.dsh/manager-agent.json
```

保存内容包括 Agent ID、Agent Token、manager URL、Agent 名称、实例 ID，以及用于重新 enrollment 的 pairing code。状态文件权限为 `0600`；startup URL/token 不会保存，日志和远端 Settings descriptor 不暴露 pairing code。

## DSH Web bootstrap

DSH Web UI 只接受启动时打印的一次性 `GET /?token=...`，成功后颁发 Cookie 并重定向到 `/`。插件通过 `ctx.connection.authenticatedUrl()` 得到启动 URL，但只把它保存在当前进程内存中：

1. manager 对新的 `/dsh/<session>/` 根请求发送 `bootstrap:true`；
2. 插件才访问内存中的 startup URL；
3. DSH 的 303 和 Set-Cookie 返回 manager；
4. 后续请求使用浏览器 Cookie；
5. manager WebSocket open 请求携带浏览器 Cookie，插件转发到本地 DSH WebSocket。

## 安全边界

- Agent Token 不提交到 Git；
- manager 只保存 Token Hash；
- plain HTTP 不提供传输加密，只用于可信网络；
- 公网必须使用外部 HTTPS/WSS 反向代理；
- 插件只代理当前 dsh Web 服务；
- startup token 不持久化、不写入日志；
- 不接受 manager 下发任意 shell。

## 开发与验证

```powershell
npm install
npm test
```

测试覆盖 HTTP manager transport、enrollment 生命周期、DSH 0.1.7 Config defaults/volatile/secret metadata、旧 saved-state 回退、ConfigForms 更新触发隧道重建、DSH startup bootstrap、Set-Cookie、gzip、二进制/流式 HTTP 和 authenticated WebSocket Cookie forwarding。

## 相关项目

- [dsh-manager](https://github.com/NevermindZZT/dsh-manager)
- [dsh-launcher](https://github.com/NevermindZZT/dsh-launcher)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

[MIT](LICENSE)
