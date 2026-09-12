# Linux / Docker 服务器版

服务器入口是 `hosted.mjs`，本机入口 `server.mjs` 继续保持原有监听约束。源码公开不等于账号、邮箱或 Cookie 公开。服务器需要可正常访问 iCloud 和 IMAP 的网络。

## 数据与权限

- 一个管理后台聚合多个独立账号。每个账号有自己的库存、生成队列与冷却时间。
- 账号创建时填写预期 Apple 登录邮箱；同步 Cookie 时通过 Apple 的认证会话核验身份，首次绑定后不自动改绑。Cookie 与转发授权码在 `platform.enc` 内加密保存，主密钥不在数据卷中。
- 管理员通过密码登录；程序 key 按账号与 scope 授权；扩展只用 upload key；收件人只用 mailbox token。
- 创建账号、生成/同步/导入邮箱不会创建收件 Token。只有明确“分发”才创建；默认永久，不设到期时间。浏览器会话独立设为 12 小时，到期重新输入原 Token 即可。
- 原分发可以撤销或重置给同一使用者，不自动二次分发。重置保留原收件时间边界，旧会话立即失效。
- 收件页使用准确收件头匹配、IMAP 接收时间边界，展示纯文本正文与验证码，默认不开放旧邮件；没有第三方跟踪图片。当前展示最近 50 封匹配邮件，不承诺永久保存全部邮件正文，实际保留期由转发邮箱决定。
- 此版是单实例单写入者；不要把同一个数据卷挂载给多个应用实例。

## 首次部署

准备两个不同域名指向服务器：一个管理员域名、一个收件域名。防火墙只开放 HTTPS/证书签发所需端口和自己的管理连接；不要开放应用内部端口或把本机 API 直接转发出去。

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
6. 选中邮箱“分发”，获得收件域名 `/inbox` 和 Token。仅给该邮箱的使用者。

Chrome 关闭时不继续同步 Cookie；已有 Cookie 是否有效取决于 Apple。Apple 的网页接口并非稳定的公开 API；身份核验失败会保留旧配置并阻止覆盖。合成测试不等于真实 Apple 登录和服务器网络已验收。

## 程序接口

后台“接口密钥”创建单账号程序 key。调用时放在 `Authorization: Bearer TOKEN` 请求头，不放进网址。

- `GET /admin-api/accounts/ACCOUNT_ID/inventory`，需要 `inventory:read`。
- `GET /admin-api/accounts/ACCOUNT_ID/emails/EMAIL_ID/messages`，需要 `mail:read`。
- `POST /admin-api/accounts/ACCOUNT_ID/generate`，需要 `generate`；后台默认只创建读取权限的程序 key。
- Cookie：`POST /bridge/v1/sync`，upload key；body 为 `{ "expectedAccountId": "ACCOUNT_ID", "cookies": [{ "name": "COOKIE_NAME", "value": "COOKIE_VALUE" }] }`。

程序 key 与收件 Token 都不具备管理员账号管理权限。不同账号的 key 混用会被拒绝。

## 更新、备份与恢复

1. 停止 app，备份整个 `mail-data` 卷；另行备份对应主密钥。不把备份放入仓库、镜像或 CI 制品。
2. 使用指定版本的代码构建并替换容器。保持数据卷不变，不运行 `down -v`。
3. 验证健康检查、账号计数、分发记录与后台计划后恢复使用。
4. 回滚应恢复匹配的程序版本、数据备份与主密钥；不要仅更换镜像并假设旧版能读新版数据。

分发长期有效不保证 Apple 地址永不失效、转发邮箱永不清理邮件或服务器永不停机；这些状态需要在后台分别检查。

## 后续必须执行的本机迁移

本地 **4173 和 4174 均有需要保留的现有邮箱**。此功能建设阶段不迁移、不停止旧服务，也不读取真实 Cookie 做 CI。

参见 [迁移清单](server-migration.md)。正式上线应先导入原有状态，再同步 Apple 核对，而不是用一个新建空库存代替迁移。

## 接口兼容性说明

服务器版从 Apple 已认证响应的 `webservices.premiummailsettings.url` 获取当前账号的服务分片；不固定某个账号的 p68 主机。地址只接受对应区域的 Apple MailDomain HTTPS 主机。该服务发现方式参考 [pyicloud 上游服务入口](https://github.com/timlaing/pyicloud/blob/master/pyicloud/base.py)，真实 Cookie 与服务器网络仍需上线前分别验收。

此版本按单实例和较低访问量设计：登录、上传、收件接口都有限速；代理后的 IP 限速是保守的共享限制，适合少量使用者，不能视为大规模邮件托管系统。升级前检查部署验收记录，不使用真实用户凭证运行自动化测试。
