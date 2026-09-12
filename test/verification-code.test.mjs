import test from "node:test";
import assert from "node:assert/strict";

import {
  extractVerificationCode,
  extractVerificationCodes
} from "../lib/verification-code.mjs";

test("关键词锚定优先于正文里其他数字串", () => {
  const text = "Order 998877 shipped. Your verification code is 445566.";

  assert.equal(extractVerificationCode(text), "445566");
  // 排序按可信度：关键词旁边的码在前，裸数字串在后。
  assert.deepEqual(extractVerificationCodes(text), ["445566", "998877"]);
});

test("关键词在后的句式同样锚定", () => {
  const text = "123456 is your code. Reference code: 987654.";

  assert.equal(extractVerificationCode(text), "123456");
  assert.deepEqual(extractVerificationCodes(text), ["123456", "987654"]);
});

test("中文关键词与分隔符写法", () => {
  assert.equal(extractVerificationCode("【Acme】您的验证码是 385204，5 分钟内有效。"), "385204");
  assert.equal(extractVerificationCode("您的校验码：9527"), "9527");
  // 连字符/空格只是排版，归一化后才是真正的码。
  assert.equal(extractVerificationCode("Your verification code is 445-566"), "445566");
  assert.equal(extractVerificationCode("Your one-time code is A1B2C3"), "A1B2C3");
});

test("页脚年份不会被当成验证码（真实故障回归）", () => {
  const mail = [
    "Verify your email",
    "Acme Inc. 2026 All rights reserved.",
    "Enter 884213 to continue."
  ].join("\n");

  assert.equal(extractVerificationCode(mail), "884213");
  assert.deepEqual(extractVerificationCodes(mail), ["884213"]);

  // 整封信只剩年份时应该老实说"没有码"，而不是把 2026 顶上去。
  assert.equal(extractVerificationCode("Verify your email\nAcme Inc. 2026 All rights reserved."), "");
  assert.deepEqual(extractVerificationCodes("Acme Inc. 2026"), []);
});

test("年份排除只覆盖 20[2-3]x，别的四位数仍然是候选", () => {
  assert.equal(extractVerificationCode("Your code is 2029"), "");
  assert.equal(extractVerificationCode("Your code is 2048"), "2048");
});

test("全同数字被排除", () => {
  assert.equal(extractVerificationCode("Your code is 000000"), "");
  assert.deepEqual(
    extractVerificationCodes("Reference 11111111. 验证码：385204"),
    ["385204"]
  );
});

test("邮件头、Exchange 标识和 IP 不会冒充验证码", () => {
  const raw = [
    "Received: from TY2PR03MB1234.eurprd03.prod.outlook.com (2603:10b6:930:88::13) by",
    " TY2PR03MB5678.eurprd03.prod.outlook.com with HTTPS; Mon, 27 Jul 2026 10:24:33 +0000",
    "Date: Mon, 27 Jul 2026 10:24:33 +0000",
    "Message-ID: <CA1234567890@mail.example.test>",
    "Subject: Verify your email",
    "",
    "Your verification code is 884213."
  ].join("\n");

  // 没有邮件头 / IPv6 清理时，"10b6" 这类 hex 分段会混进候选。
  assert.equal(extractVerificationCode(raw), "884213");
  assert.deepEqual(extractVerificationCodes(raw), ["884213"]);
});

test("正文里的 Exchange 传输 ID 不进候选", () => {
  const text = "Message routed via CA12345 relay. 请使用验证码 778899 完成验证。";

  assert.equal(extractVerificationCode(text), "778899");
  assert.deepEqual(extractVerificationCodes(text), ["778899"]);
});

test("登录提醒里的 IP 不产生验证码", () => {
  const text = "New sign-in from 203.0.113.45 on 27 Jul.";

  assert.equal(extractVerificationCode(text), "");
  assert.deepEqual(extractVerificationCodes(text), []);
});

test("重复出现的码只保留一个", () => {
  assert.deepEqual(
    extractVerificationCodes("验证码 445566。若非本人操作请忽略。验证码 445566"),
    ["445566"]
  );
});

test("空输入返回空值而不是抛异常", () => {
  for (const input of ["", "   ", null, undefined, "no digits here"]) {
    assert.equal(extractVerificationCode(input), "");
    assert.deepEqual(extractVerificationCodes(input), []);
  }
});

test("兼容 lib/mail-content.mjs 旧调用方的编码顺序期望", () => {
  // 旧实现（裸 \d{4,8}）在这条用例上的输出，替换后必须保持一致。
  assert.deepEqual(
    extractVerificationCodes(
      "Verification code 123456. Backup code 987654. Repeat 123456."
    ),
    ["123456", "987654"]
  );
  assert.deepEqual(
    extractVerificationCodes("Code 445566. Open https://plain.example.test/verify."),
    ["445566"]
  );
});

test("两个导出共用同一条流水线：codes[0] 恒等于单值结果", () => {
  const samples = [
    "Your verification code is 445566. Order 998877.",
    "【Acme】您的验证码是 385204",
    "Acme Inc. 2026 All rights reserved.",
    "123456 is your code. Reference code: 987654.",
    ""
  ];

  for (const sample of samples) {
    assert.equal(
      extractVerificationCodes(sample)[0] || "",
      extractVerificationCode(sample)
    );
  }
});
