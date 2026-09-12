import test from "node:test";
import assert from "node:assert/strict";

import { __test } from "../server.mjs";

const { simplifyAuthError } = __test;

test("IMAP 认证失败指向转发邮箱配置，而不是已删除的 OAuth 通道", () => {
  const message = simplifyAuthError(
    "Command failed: AUTHENTICATE failed for synthetic@example.com"
  );

  assert.match(message, /mail-forward\.config\.json/);
  assert.doesNotMatch(message, /Token|OAuth|Graph|Outlook/i);
});

test("IMAP 超时不被当成邮箱失效", () => {
  const message = simplifyAuthError("Socket timeout while reading INBOX");

  assert.match(message, /可稍后重试/);
  assert.doesNotMatch(message, /Outlook/i);
});

test("认不出的错误原样透传", () => {
  assert.equal(
    simplifyAuthError("getaddrinfo ENOTFOUND imap.example.com"),
    "getaddrinfo ENOTFOUND imap.example.com"
  );
});

test("Graph 与 refresh token 的说辞已经不再出现", () => {
  // 2.9 的收尾：服务端不再持有 refresh token，也就没有理由再向操作者
  // 建议“重新生成授权”。
  for (const raw of [
    "invalid_grant: AADSTS70000 refresh token expired",
    "Access token does not contain Mail.Read permissions"
  ]) {
    assert.equal(simplifyAuthError(raw), raw);
  }
});
