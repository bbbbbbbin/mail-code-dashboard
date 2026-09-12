// 共享的验证码提取器。
//
// 在此之前仓库里有两份互相不知道对方存在的实现：
//   - server.mjs 的 extractCode()：关键词锚定 + 一整套误报排除，但只服务转发箱路径；
//   - lib/mail-content.mjs 的 extractVerificationCodes()：裸的 /\d{4,8}/g，没有任何锚定，
//     偏偏 v1 主路径和 lib/inventory-mail-service.mjs（直接取 codes[0]）用的是它。
// 结果就是主题 "Verify your email"、正文 "Acme Inc. 2026 ..." 的邮件，卡片上显示的
// 验证码是 "2026"。这里以强版为准把两者合并，两个导出共用同一条候选流水线，
// 避免以后再次跑偏。

// —— 噪声清理 ——
// 这些片段在进入候选扫描前就整段抹掉，因为它们里面的数字串长得和验证码一模一样，
// 靠后面的打分是分不出来的。

// 邮件头行。有调用方会把整封原始邮件丢进来，Received/Date/Message-ID 里全是
// 4~10 位数字（时间戳、序列号），不清掉几乎必然抢在正文验证码前面被选中。
// 末尾的 (?:\r?\n[ \t].*)* 是 server.mjs 原版没有的：RFC 5322 的折行续接行以空白开头，
// 只删首行会把 "with HTTPS; Mon, 27 Jul 2026 10:24:33" 这半截留在正文里，
// 于是 "2026 10" 被当成一个 6 位数字码。只吃紧跟在已匹配头部后面的续行，不碰别处。
const HEADER_LINE_PATTERN =
  /^(?:received|from|to|subject|date|message-id|return-path|authentication-results|dkim-signature|received-spf):.*(?:\r?\n[ \t].*)*$/gim;

// Exchange / Office365 的服务器标识，形如 "TYZPR03MB5473"、"SJ0PR11MB4900"。
// 归一化后是 10 位以内的字母数字混排，正好落进宽松候选那一档。
const EXCHANGE_SERVER_ID_PATTERN = /\b[A-Z]{2,}\d[A-Z0-9]*PR\d{2}MB\d+\b/gi;

// Exchange 传输层的 conversation / message id 尾巴，形如 "CA1234567890"。
const EXCHANGE_TRANSPORT_ID_PATTERN = /\b[A-Z0-9]*CA\d{4,}\b/gi;

// IPv4：Received 头之外，正文里的 "登录 IP 203.0.113.45" 也会贡献 "113" "45" 之类
// 的碎片；整段抹掉比逐个候选去判断便宜。
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

// Microsoft 出口网段的 IPv6 前缀（2603:...），在 Exchange 邮件头里成片出现。
const IPV6_EXCHANGE_PATTERN = /\b2603:[a-f0-9:]+\b/gi;

// —— 候选扫描 ——
// 三档可信度，从"旁边就写着'验证码'"到"看起来像个码"。

// 第 1 档：关键词在前，"验证码：123456" / "Your verification code is 123456"。
const KEYWORD_PREFIX_PATTERN =
  /(?:验证码|校验码|动态码|一次性代码|安全代码|verification code|security code|one[-\s]?time code|passcode|otp|code)(?:\s*(?:is|为|是|:|：|-|=))*\s*([A-Z0-9][A-Z0-9 \t-]{2,18}[A-Z0-9])/gi;

// 第 1 档：关键词在后，"123456 是你的验证码" / "123456 is your code"。
const KEYWORD_SUFFIX_PATTERN =
  /([A-Z0-9][A-Z0-9 \t-]{2,18}[A-Z0-9])\s*(?:是你的验证码|为你的验证码|is your code|is your verification code)/gi;

// 第 2 档：纯数字串，允许中间被空格或连字符切开（"123 456"、"12-34-56"）。
const DIGIT_RUN_PATTERN = /(?<![A-Z0-9])(?:\d[\s-]?){4,8}(?![A-Z0-9])/gi;

// 第 3 档：字母数字混排且至少含一位数字（"A1B2C3"）。误报最多，只在前两档都空时才有意义。
const LOOSE_ALNUM_PATTERN =
  /(?<![A-Z0-9])(?=[A-Z0-9]{4,10}(?![A-Z0-9]))(?=[A-Z0-9]*\d)[A-Z0-9]{4,10}/gi;

const SCORE_KEYWORD_ANCHORED = 100;
const SCORE_DIGIT_RUN = 50;
const SCORE_LOOSE_ALNUM = 20;

// 两种关键词写法同分：原版 extractCode 是先把"关键词在前"的正则跑完整篇再考虑
// "关键词在后"，于是 "123456 is your code. Reference code: 987654." 会返回 987654。
// 这里同分按出现位置决胜，返回 123456 —— 这是刻意的修正，不是搬运事故。
const CANDIDATE_SOURCES = [
  { pattern: KEYWORD_PREFIX_PATTERN, score: SCORE_KEYWORD_ANCHORED },
  { pattern: KEYWORD_SUFFIX_PATTERN, score: SCORE_KEYWORD_ANCHORED },
  { pattern: DIGIT_RUN_PATTERN, score: SCORE_DIGIT_RUN },
  { pattern: LOOSE_ALNUM_PATTERN, score: SCORE_LOOSE_ALNUM }
];

function scrubNoise(text) {
  return String(text ?? "")
    .replace(HEADER_LINE_PATTERN, " ")
    .replace(EXCHANGE_SERVER_ID_PATTERN, " ")
    .replace(EXCHANGE_TRANSPORT_ID_PATTERN, " ")
    .replace(IPV4_PATTERN, " ")
    .replace(IPV6_EXCHANGE_PATTERN, " ");
}

/**
 * 把一段原始匹配收敛成规范形式，顺便把明显不是验证码的形状挡掉。
 * 返回 "" 表示这个候选作废。
 */
function normalizeCodeCandidate(value) {
  const candidate = String(value || "")
    .toUpperCase()
    .replace(/[\s-]+/g, "");

  // 长度和字符集：验证码就没见过短于 4 位或长于 10 位的。
  if (!/^[A-Z0-9]{4,10}$/.test(candidate)) return "";

  // 一位数字都没有的纯单词（"VERIFY"、"ACCOUNT"）不是码。
  if (!/\d/.test(candidate)) return "";

  // 年份：真实故障就是这条 —— 页脚 "Acme Inc. 2026" 被当成验证码显示在卡片上。
  // 只挡 2020~2039，别的四位数（"2048"）仍然可能是真码。
  if (/^20[2-3]\d$/.test(candidate)) return "";

  // 全同数字："00000000" 之类基本来自表格填充、占位符或被抹掉的敏感字段，
  // 而不是发信方真的发了一个 8 个 0 的验证码。
  if (
    /^(?:0{4,10}|1{4,10}|2{4,10}|3{4,10}|4{4,10}|5{4,10}|6{4,10}|7{4,10}|8{4,10}|9{4,10})$/.test(
      candidate
    )
  ) {
    return "";
  }

  // 含数字的技术词汇（UTF8 / BASE64 …）会通过上面的"至少一位数字"检查，
  // 只能按名单挡掉；其余无数字的词早就被前面的规则筛走了。
  if (/^(?:HTTP|HTML|UTF8|BASE64|TOKEN|LOGIN|EMAIL|OUTLOOK|MICROSOFT)$/i.test(candidate)) {
    return "";
  }

  return candidate;
}

/**
 * 扫出全部候选并按可信度降序排列。同一个码被多档规则命中时只保留分数最高的那次，
 * 同分则按在文本里首次出现的位置排，保证结果稳定、可预期。
 */
function rankCandidates(text) {
  const value = scrubNoise(text);
  const best = new Map();

  for (const { pattern, score } of CANDIDATE_SOURCES) {
    // matchAll 会克隆正则，模块级常量的 lastIndex 不会被这里污染。
    for (const match of value.matchAll(pattern)) {
      const raw = match[1] ?? match[0];
      const code = normalizeCodeCandidate(raw);
      if (!code) continue;

      // 关键词档的捕获组不在匹配开头，把偏移补回来，排序才对得上文本顺序。
      const offset = match[0].indexOf(raw);
      const index = match.index + (offset < 0 ? 0 : offset);

      const existing = best.get(code);
      if (
        !existing ||
        score > existing.score ||
        (score === existing.score && index < existing.index)
      ) {
        best.set(code, { code, score, index });
      }
    }
  }

  return [...best.values()].sort(
    (a, b) => b.score - a.score || a.index - b.index
  );
}

/**
 * 返回最可信的一个验证码；找不到返回 ""。
 * 取代 server.mjs 里的 extractCode(text)。
 */
export function extractVerificationCode(text) {
  return rankCandidates(text)[0]?.code || "";
}

/**
 * 返回去重后、按可信度降序排列的验证码数组；找不到返回 []。
 * 调用方（lib/inventory-mail-service.mjs）取 codes[0] 就是最佳答案。
 */
export function extractVerificationCodes(text) {
  return rankCandidates(text).map(candidate => candidate.code);
}
