# Chrome iCloud Cookie Bridge

将当前 Chrome 配置文件中的 iCloud 会话 Cookie 同步到 Mail Code Dashboard。支持 HTTPS 服务器模式与回环地址的单机模式。

## 安装

1. 打开 `chrome://extensions/`，启用开发者模式。
2. 选择“加载已解压的扩展程序”。
3. 选择本扩展目录。

扩展采用 Chromium Manifest V3。多个 iCloud 账号应使用独立 Chrome 配置文件，并分别配置对应账号；在同一配置文件里打开多个窗口仍会共享 Cookie。

## 服务器模式

1. 在管理后台创建 iCloud 账号，为该账号创建专属同步密钥。
2. 在扩展弹窗启用服务器模式。
3. 填写后台提供的 HTTPS 管理地址、账号编号、同步密钥和 iCloud 区域。
4. 授予该管理域名访问权限，保存后点击“立即同步”。

服务器会核验 Apple 会话身份和目标账号。身份不符或 Cookie 冲突时拒绝覆盖。同步密钥仅用于对应账号的 Cookie 上传，不具备管理员、邮件读取或分发权限。

更换服务器或目标账号时需要对应的新同步密钥。停用服务器模式会恢复单机模式设置，不清除原有配置。

## 单机模式

填写服务实际监听的端口和该实例的 API Key。扩展向以下接口提交白名单 Cookie：

```text
http://127.0.0.1:PORT/api/edge-cookie-bridge
```

`PORT` 由使用者配置。每个账号的服务实例应有独立的凭证、库存、日志与状态目录。单机接口仅用于回环地址访问，远程部署应使用服务器模式。

## 同步与存储

配置保存在当前 Chrome 配置文件的 `chrome.storage.local`。支持手动同步、定时同步和 Cookie 变化触发；Chrome 关闭后停止扩展任务。

仅同步隐藏邮箱功能使用的白名单 Cookie：

- `X-APPLE-DS-WEB-SESSION-TOKEN`
- `X-APPLE-WEBAUTH-TOKEN`
- `X-APPLE-WEBAUTH-PCS-Mail`
- `X-APPLE-WEBAUTH-HSA-TRUST`
- `X-APPLE-WEBAUTH-LOGIN`
- `X-APPLE-WEBAUTH-USER`

不要分享同步密钥或浏览器配置文件；凭证失效时在对应 Chrome 重新登录并同步。

## 校验

```sh
node --check background.js
node --check popup.js
node --check hosted-popup.js
node scripts/smoke_extension_config.mjs
python scripts/validate_extension.py
node --test test/background.test.mjs
```
