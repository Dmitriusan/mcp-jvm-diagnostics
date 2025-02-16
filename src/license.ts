/**
 * License validation for MCP Migration Advisor (Pro features).
 *
 * Validates license keys offline using HMAC-SHA256.
 * Missing or invalid keys gracefully degrade to free mode — never errors.
 *
 * Key format: MCPJBS-XXXXX-XXXXX-XXXXX-XXXXX
 * Payload (12 bytes = 20 base32 chars):
 *   [0]     product mask (8 bits)
 *   [1-2]   expiry days since 2026-01-01 (16 bits)
 *   [3-5]   customer ID (24 bits)
 *   [6-11]  HMAC-SHA256 truncated (48 bits)
 */

import { createHmac } from "node:crypto";

const KEY_PREFIX = "MCPJBS-";
const EPOCH = new Date("2026-01-01T00:00:00Z");
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const HMAC_SECRET = "mcp-java-backend-suite-license-v1";

const PRODUCTS: Record<string, number> = {
  "db-analyzer": 0,
  "jvm-diagnostics": 1,
  "migration-advisor": 2,
  "spring-boot-actuator": 3,
  "redis-diagnostics": 4,
};

export interface LicenseInfo {
  isPro: boolean;
  expiresAt: Date | null;
  customerId: number | null;
  reason: string;
}

export function validateLicense(
  key: string | undefined,
  product: string
): LicenseInfo {
  const FREE: LicenseInfo = {
    isPro: false,
    expiresAt: null,
    customerId: null,
    reason: "No license key provided",
  };

  if (!key || key.trim().length === 0) return FREE;

  const trimmed = key.trim().toUpperCase();
  if (!trimmed.startsWith(KEY_PREFIX)) {
    return { ...FREE, reason: "Invalid key format: missing MCPJBS- prefix" };
  }

  const body = trimmed.slice(KEY_PREFIX.length).replace(/-/g, "");
  if (body.length < 20) {
    return { ...FREE, reason: "Invalid key format: too short" };
  }

  let decoded: Buffer;
  try {
    decoded = base32Decode(body.slice(0, 20));
  } catch {
    return { ...FREE, reason: "Invalid key format: bad base32 encoding" };
  }

  if (decoded.length < 12) {
    return { ...FREE, reason: "Invalid key format: decoded data too short" };
  }

  const payload = decoded.subarray(0, 6);
  const providedSignature = decoded.subarray(6, 12);

  const expectedHmac = createHmac("sha256", HMAC_SECRET)
    .update(payload)
    .digest();
  const expectedSignature = expectedHmac.subarray(0, 6);

  if (!providedSignature.equals(expectedSignature)) {
    return { ...FREE, reason: "Invalid license key: signature mismatch" };
  }

  const productMask = payload[0];
  const daysSinceEpoch = (payload[1] << 8) | payload[2];
  const customerId = (payload[3] << 16) | (payload[4] << 8) | payload[5];

  const productBit = PRODUCTS[product];
  if (productBit === undefined) {
    return { ...FREE, reason: `Unknown product: ${product}` };
  }
  if ((productMask & (1 << productBit)) === 0) {
    return { ...FREE, customerId, reason: `License does not include ${product}` };
  }

  const expiresAt = new Date(
    EPOCH.getTime() + daysSinceEpoch * 24 * 60 * 60 * 1000
  );
  if (new Date() > expiresAt) {
    return {
      isPro: false,
      expiresAt,
      customerId,
      reason: `License expired on ${expiresAt.toISOString().slice(0, 10)}`,
    };
  }

  return { isPro: true, expiresAt, customerId, reason: "Valid Pro license" };
}

export function formatUpgradePrompt(
  toolName: string,
  featureDescription: string
): string {
  return [
    `## ${toolName} (Pro Feature)`,
    "",
    "This analysis is available with MCP Java Backend Suite Pro.",
    "",
    `**What you'll get:**`,
    featureDescription,
    "",
    "**Upgrade**: https://mcpjbs.dev/pricing",
    "**Price**: $19/month or $190/year",
    "",
    "> Already have a key? Set `MCP_LICENSE_KEY` in your Claude Desktop config.",
  ].join("\n");
}

function base32Decode(encoded: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of encoded) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }

  return Buffer.from(bytes);
}
