import crypto from "crypto";

/**
 * Meta access token, app secret ar verify token gulo database e
 * plaintext e rakha jabe na. Ekhane AES-256-GCM diye encrypt kori.
 *
 * .env e ei line ta lagbe:
 *   SECRETS_KEY=<64 character hex>
 *
 * Key banate:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * ⚠️  Ei key hariye gele sob token decrypt kora jabe na. Backup rakh.
 */

const PREFIX = "enc:v1:";

function getKey(): Buffer {
  const hex = process.env.SECRETS_KEY;
  if (!hex) {
    throw new Error(
      "SECRETS_KEY missing. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error("SECRETS_KEY must be exactly 64 hex characters (32 bytes).");
  }
  return key;
}

/** Plaintext → "enc:v1:<iv>:<tag>:<ciphertext>" */
export function encrypt(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === "") return null;
  if (plain.startsWith(PREFIX)) return plain; // already encrypted

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${enc.toString("base64url")}`;
}

/**
 * "enc:v1:..." → plaintext.
 * Migration er por purono plaintext token gulo jemon ache temon-i ferot dey,
 * jate ekbar Save korar age porjonto sob kaj korte thake.
 */
export function decrypt(stored: string | null | undefined): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext

  try {
    const [, , ivB64, tagB64, dataB64] = stored.split(":");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      getKey(),
      Buffer.from(ivB64, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    console.error("Secret decryption failed. Wrong SECRETS_KEY?", err);
    return "";
  }
}

/** UI te token dekhanor jonno: "EAAG…9xKd" */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 12) return "••••••••";
  return `${value.slice(0, 4)}${"•".repeat(8)}${value.slice(-4)}`;
}

/** Timing-safe compare — verify token milanor jonno */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a || "");
  const bufB = Buffer.from(b || "");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Meta webhook signature verify: X-Hub-Signature-256 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return safeEqual(signatureHeader, expected);
}

/** Notun random secret (verify token, n8n secret) */
export function generateSecret(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
