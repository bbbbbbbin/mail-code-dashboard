import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function readExistingKey(keyPath) {
  try {
    const value = (await readFile(keyPath, "utf8")).trim();
    return value || null;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function loadOrCreateApiKey({
  env = process.env,
  keyPath
}) {
  const environmentKey = String(env.MAIL_DASHBOARD_API_KEY || "").trim();
  if (environmentKey) {
    return {
      key: environmentKey,
      source: "environment",
      keyPath: null
    };
  }

  const existingKey = await readExistingKey(keyPath);
  if (existingKey) {
    return {
      key: existingKey,
      source: "file",
      keyPath
    };
  }

  await mkdir(dirname(keyPath), { recursive: true });
  const generatedKey = randomBytes(32).toString("base64url");
  try {
    await writeFile(keyPath, `${generatedKey}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    return {
      key: generatedKey,
      source: "generated",
      keyPath
    };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    const racedKey = await readExistingKey(keyPath);
    if (!racedKey) {
      throw error;
    }
    return {
      key: racedKey,
      source: "file",
      keyPath
    };
  }
}
