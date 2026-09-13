# 信屿 MailIsle · Linux / Docker 部署

服务器入口是 `hosted.mjs`，单机入口 `server.mjs` 仅用于回环地址访问。服务器需要可正常访问 iCloud 和 IMAP 的网络。

## 数据与权限

- 一个管理后台聚合多个独立账号。每个账号有自己的库存、生成队列与冷却时间。
- 账号创建时填写预期 Apple 登录邮箱；同步 Cookie 时通过 Apple 的认证会话核验身份，首次绑定后不自动改绑。Cookie 与转发授权码在 `platform.enc` 内加密保存，主密钥不在数据卷中。
- 管理员通过密码登录；程序 key 按账号与 scope 授权；扩展只用 upload key；收件人只用 mailbox token。
- 创建账号、生成/同步/导入邮箱不会创建收件 Token。只有明确“分发”才创建。管理页默认分享 7 天，支持 7 / 30 / 90 天、自定义 1–3650 天或永久；原有永久分享不受升级影响。
- 有效期从服务端创建时间起算，一天为 24 小时。服务端在登录、取信前和取信后核验到期时间，已打开的会话也受限制。
- 原分发可以撤销或重置给同一使用者，不自动二次分发。重置保留原收件时间边界及到期时间；需要延期时单独调整有效期。更改有效期从操作时起重新计算，并使旧会话失效；已撤销的授权保持撤销。
- 浏览器会话最长 12 小时；会话过期后，重新打开仍有效的原始链接或输入对应 Token 登录。
- 收件页使用准确收件头匹配、IMAP 接收时间边界，展示纯文本正文与验证码，默认不开放旧邮件；没有第三方跟踪图片。当前展示最近 50 封匹配邮件，不承诺永久保存全部邮件正文，实际保留期由转发邮箱决定。
- 此版是单实例单写入者；不要把同一个数据卷挂载给多个应用实例。

## 首次部署

准备两个不同域名指向服务器：一个管理员域名、一个收件域名。防火墙只开放 HTTPS/证书签发所需端口和自己的管理连接；不要开放应用内部端口或把单机 API 直接转发出去。

```sh
git clone https://github.com/bbbbbbbin/mail-code-dashboard.git
cd mail-code-dashboard
cp deploy/env.example .env
# 编辑 .env，填写 ADMIN_DOMAIN、MAIL_DOMAIN。
install -d -m 700 secrets
umask 077
openssl rand -base64 32 > secrets/master-key
# 在 bash 中输入初始化密码，不把密码写进命令历史：
read -r -s -p '管理员密码（至少14位）: ' ADMIN_PASSWORD; echo
printf '%s' "$ADMIN_PASSWORD" > secrets/admin-password
unset ADMIN_PASSWORD
# 容器以 UID 1000 运行，需能读取这两个文件；按服务器实际权限调整：
sudo chown 1000:1000 secrets/master-key secrets/admin-password
docker compose build app
docker compose --profile setup run --rm initialize --username=admin
docker compose up -d
docker compose ps
```

初始化完成后，将 `secrets/admin-password` 清空，后续通过后台更改密码；不要重复初始化。初始化命令遇到已有数据时退出，不覆盖。

Compose secrets 是文件挂载，**不是宿主机自动加密**。妥善保护主密钥文件及其离线备份，丢失密钥将失去对加密配置的读取能力。备份数据卷时也要保护其中的邮箱状态、邮件摘要和操作记录。

## 配置流程

1. 登录管理员域名 `/admin`；新增账号，填写名称和真实 Apple 登录邮箱。
2. 为该账号创建同步密钥，复制服务器地址、accountId 和 `upl_` 密钥。
3. 对应 Chrome 加载仓库中的 `extensions/chrome-cookie-bridge` 扩展，开启服务器模式，保存上述三项及 iCloud 区域。只授权实际服务器域名。
4. 在该 Chrome 登录 iCloud 并同步；核验成功后在后台启用账号。
5. 配置该账号的转发 IMAP 邮箱及应用授权码。先同步库存和检查邮件，再开启后台生成。
6. 选中邮箱“分享”，选择有效天数，复制收件链接。接收方打开链接即自动登录；也保留手动输入 Token 的入口。链接只给该邮箱的使用者。

### 链接与到期管理

链接形式为 `https://inbox.example.test/inbox#token=TOKEN`。片段由浏览器处理，不随初始 HTTP 请求发送；页面在使用前清除片段，然后通过 HTTPS 请求体交换收件会话。页面不会把 Token 保存在 localStorage / sessionStorage。不要使用把 Token 放在查询参数、路径或访问日志中的外部短链服务。

完整链接仅在创建或重置时返回，服务端仍只保存 Token 摘要。在“分享管理”可以查看到期时间，调整有效期、重置或撤销。调整为有限期时从当前服务端时间起算，而不是叠加剩余天数；选择永久后取消到期限制。重置只更换凭证，不自动续期；原邮件可见时间范围与分发对象不变。

链接持有者具有该邮箱的收件权限。聊天软件、浏览器扩展和剪贴板工具仍可能接触完整链接；片段机制不等于一次性链接或实名身份验证。撤销或到期阻止后续取信，已被接收方阅读、复制或下载的内容不会被追回。

Chrome 关闭时不继续同步 Cookie；已有 Cookie 是否有效取决于 Apple。Apple 的网页接口并非稳定的公开 API；身份核验失败会保留旧配置并阻止覆盖。合成测试不等于真实 Apple 登录和服务器网络已验收。

## 程序接口

后台“接口密钥”创建单账号程序 key。调用时放在 `Authorization: Bearer TOKEN` 请求头，不放进网址。

- `GET /admin-api/accounts/ACCOUNT_ID/inventory`，需要 `inventory:read`。
- `GET /admin-api/accounts/ACCOUNT_ID/emails/EMAIL_ID/messages`，需要 `mail:read`。
- `POST /admin-api/accounts/ACCOUNT_ID/generate`，需要 `generate`；后台默认只创建读取权限的程序 key。
- Cookie：`POST /bridge/v1/sync`，upload key；body 为 `{ "expectedAccountId": "ACCOUNT_ID", "cookies": [{ "name": "COOKIE_NAME", "value": "COOKIE_VALUE" }] }`。

### 管理员分享接口

以下接口只允许管理员会话，并要求匹配的 `Origin` 和 `X-CSRF-Token`；程序 key 不具备分享管理权限。

- `POST /admin-api/accounts/ACCOUNT_ID/distribute`
  - 请求：`{ "emailIds": ["EMAIL_ID"], "recipient": "分享用途", "includeHistory": false, "durationDays": 7 }`。
  - `durationDays` 为 1–3650 的整数，`null` 表示永久。为兼容已有调用方，API 省略此字段也按永久处理；管理页始终提交明确选择。
  - 响应包含 `inboxUrl` 和 `grants`；每个 grant 在本次响应中带独立 `token`、`shareUrl`、`expiresAt`。批量分享不共用凭证。
- `PATCH /admin-api/grants/GRANT_ID`：请求 `{ "durationDays": 30 }` 或 `{ "durationDays": null }`，显式调整原授权有效期，不生成新 Token。
- `POST /admin-api/grants/GRANT_ID/reset`：重置凭证，响应含新 `token`、`shareUrl`、`inboxUrl`；旧链接与会话失效，到期时间不自动延长。
- `POST /admin-api/grants/GRANT_ID/revoke`：撤销后停止该授权取信，不删除邮箱。
- `GET /admin-api/grants`：返回分享记录，状态包括 `active`、`expired`、`revoked`；不返回完整 Token、链接或 Token 摘要。

`POST /mail-api/login` 与 `GET /mail-api/messages` 返回实际 `expiresAt`（永久为 `null`）。过期授权返回 HTTP 401 / `MAIL_ACCESS_EXPIRED`。无效天数返回 HTTP 400 / `INVALID_DURATION_DAYS`，校验失败不生成授权。

程序 key 与收件 Token 都不具备管理员账号管理权限。不同账号的 key 混用会被拒绝。

## 更新、备份与恢复

1. 停止 app，备份整个 `mail-data` 卷；另行备份对应主密钥。不把备份放入仓库、镜像或 CI 制品。
2. 使用指定版本的代码构建并替换容器。保持数据卷不变，不运行 `down -v`。
3. 验证健康检查、账号计数、分发记录与后台计划后恢复使用。
4. 回滚应恢复匹配的程序版本、数据备份与主密钥；不要仅更换镜像并假设旧版能读新版数据。

分发长期有效不保证 Apple 地址永不失效、转发邮箱永不清理邮件或服务器永不停机；这些状态需要在后台分别检查。

## 接口兼容性说明

服务器版从 Apple 已认证响应的 `webservices.premiummailsettings.url` 获取当前账号的服务分片；不固定某个账号的 p68 主机。地址只接受对应区域的 Apple MailDomain HTTPS 主机。该服务发现方式参考 [pyicloud 上游服务入口](https://github.com/timlaing/pyicloud/blob/master/pyicloud/base.py)，真实 Cookie 与服务器网络仍需上线前分别验收。

此版本按单实例和较低访问量设计：登录、上传、收件接口都有限速；代理后的 IP 限速是保守的共享限制，适合少量使用者，不能视为大规模邮件托管系统。升级前运行项目测试，并使用独立测试账号验证配置。
