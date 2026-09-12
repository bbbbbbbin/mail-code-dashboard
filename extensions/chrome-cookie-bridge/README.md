# Chrome iCloud Cookie Bridge

把**当前 Chrome 配置文件**里的 iCloud 登录 Cookie，同步到本机
`mail-code-dashboard` 实例。服务端只监听 `127.0.0.1`，Cookie 不会发往公网。

## 双账号用法

为两个 iCloud 账号建立两个独立的 Chrome 配置文件（或两个独立的
`--user-data-dir`），分别登录账号 A、账号 B。不要只在同一配置文件里开两个窗口，
那样 Cookie 仍然共用。

| Chrome 配置文件 | 服务端口 | 服务实例目录 |
| --- | ---: | --- |
| 账号 A | `4173` | `account-a` |
| 账号 B | `4174` | `account-b` |

每个服务实例都必须有自己的 Cookie、库存状态、备份目录、API key、
标签序列和转发邮箱配置。项目里的
`scripts/start_dashboard_instance.ps1` 会自动设置这些路径。

## 安装

1. 打开 `chrome://extensions/`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录：`extensions/chrome-cookie-bridge`。
5. 在 Chrome 配置文件 A、B 中分别重复安装一次。

插件使用标准 Chromium Manifest V3 和 `chrome.*` API，可直接在 Chrome 中运行；
目录名不再代表必须使用 Edge。

## 配置

在账号 A 的 Chrome 配置文件中打开插件弹窗：

- 本地服务端口：`4173`
- API key：`account-a` 实例目录里的 `api-key.txt`

在账号 B 的 Chrome 配置文件中打开插件弹窗：

- 本地服务端口：`4174`
- API key：`account-b` 实例目录里的 `api-key.txt`

端口和 API key 存在当前 Chrome 配置文件的 `chrome.storage.local`，所以两个配置文件
可以同时保存不同的目标。保存后点击“立即同步”，或等待插件的定时同步。

## Cookie 白名单

只同步 HME 链路需要的六个 Cookie：

- `X-APPLE-DS-WEB-SESSION-TOKEN`
- `X-APPLE-WEBAUTH-TOKEN`
- `X-APPLE-WEBAUTH-PCS-Mail`
- `X-APPLE-WEBAUTH-HSA-TRUST`
- `X-APPLE-WEBAUTH-LOGIN`
- `X-APPLE-WEBAUTH-USER`

Cookie 只会 POST 到当前配置的
`http://127.0.0.1:<port>/api/edge-cookie-bridge`，并携带对应 API key。

## 自检

```powershell
node --check .\background.js
node --check .\popup.js
node .\scripts\smoke_extension_config.mjs
python .\scripts\validate_extension.py
node --test .\test\background.test.mjs
```

## 安全

- 不要把 Cookie、API key、Apple ID、真实邮箱或转发邮箱密码提交到 Git。
- 不要把端口改成公网地址；服务固定使用 `127.0.0.1`。
- 不要让两个 Chrome 配置文件指向同一个服务端口或同一套状态文件。

## 服务器模式（1.3.0）

本机模式保持原有 4173 / 4174 配置不变。部署服务器后，在各自 Chrome 中启用“服务器模式”，分别填写后台提供的 HTTPS 管理地址、账号编号和该账号的专属同步密钥（upl_）。只授予这个管理域名的访问权限。

服务器模式会向 `/bridge/v1/sync` 上传白名单 Cookie，并核验真实 Apple 会话归属；账号不匹配或 Cookie 冲突时保留原数据。同步密钥没有管理其他账号、读取邮件或生成分发 Token 的权限。更换服务器或账号时必须提供对应的新同步密钥。关闭服务器模式可回到原本机设置。

**现有 4173 / 4174 用户先完成迁移验收，再切换扩展目标；本轮不要提前切换。**
