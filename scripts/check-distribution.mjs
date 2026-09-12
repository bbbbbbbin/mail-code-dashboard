import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean))];
const forbiddenPath = /(?:^|\/)(?:node_modules|__pycache__|exports|\.venv|\.git)(?:\/|$)|(?:^|\/)(?:cookies\.txt|api-key\.txt|mail-forward\.config\.json|icloud-label-sequence\.json|\.env(?:\..*)?)$|\.(?:log|zip|pyc)$/i;
const failures = [];
const privateDocuments = new Set(['UPLOAD.md', 'docs/server-migration.md', 'docs/server-verification.md', 'docs/plans/server-platform.md']);
for (const file of files) {
  if (privateDocuments.has(file)) failures.push(`private working notes: ${file}`);
  if (forbiddenPath.test(file) || /^(data|secrets)\//.test(file) || /\.(enc|sqlite|db|pem|key)$/.test(file) || /^(runtime|logs)\//.test(file) && !file.endsWith("/.gitkeep")) failures.push(`private path: ${file}`);
  if (/wildmango/i.test(file)) failures.push(`excluded feature: ${file}`);
  if (/\.(?:md|mjs|js|html|json|py|ps1|yml|yaml)$/.test(file)) {
    const text = readFileSync(resolve(root, file), "utf8");
    if (/gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/.test(text)) failures.push(`credential pattern: ${file}`);
    if (/\b(?:upl|api|mbx|ses)_[A-Za-z0-9_-]{43}\b/.test(text)) failures.push(`hosted credential pattern: ${file}`);
    if (file.endsWith(".md")) {
      if (/https?:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}\b/.test(text)) failures.push(`use a PORT placeholder in public documentation: ${file}`);
      if (/(?:[a-z]:[\\/]Users[\\/][^\\/\s]+[\\/]|\/(?:Users|home)\/[^/\s]+\/)/i.test(text)) failures.push(`personal filesystem path in documentation: ${file}`);
      for (const match of text.matchAll(/(?<!!)\[[^\]]+\]\(([^)\s]+)\)/g)) {
        const target = match[1].split("#")[0];
        if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
        if (!existsSync(resolve(root, dirname(file), decodeURIComponent(target)))) failures.push(`broken link: ${file} -> ${target}`);
      }
    }
  }
}
assert.deepEqual(failures, [], "distribution must contain only standalone source and working documentation links");
assert.ok(!readFileSync(resolve(root, "server.mjs"), "utf8").match(/wildmango/i));
assert.ok(!readFileSync(resolve(root, "mail-code-dashboard.html"), "utf8").match(/wildmango/i));
console.log(`Distribution check passed: ${files.length} source files; no runtime credentials, excluded feature or broken Markdown links.`);
