/**
 * JWT helpers for CodeBuddy China (and other OAuth-based providers).
 *
 * The proxy stores the full login response (access_token + refresh_token +
 * metadata) in the account's `tokens` column. The `exp` claim in the JWT
 * payload lets us fast-detect an expired access token without an extra API
 * round-trip — see CodeBuddyChinaProvider.validateApiKey.
 *
 * These helpers are intentionally dependency-free (no jsonwebtoken) and only
 * decode the public payload — they do NOT verify the signature (the upstream
 * provider does that on each request).
 */

/**
 * Decode a JWT's payload and read the `exp` (expiry) claim.
 * @param jwt — a compact JWT string (header.payload.signature)
 * @returns expiry as unix seconds, or null if not a JWT / no exp claim
 */
export function decodeJwtExp(jwt: string): number | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    // JWT uses base64url (no padding). Convert to base64 and pad.
    let b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const payload = JSON.parse(
      Buffer.from(b64, "base64").toString("utf8")
    );
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Cheap structural check: does this look like a compact JWT?
 * (header.payload.signature, header starts with eyJ — base64url of {"alg":...).
 * Used to distinguish a JWT access_token from a ck_... API key.
 */
export function looksLikeJwt(s: unknown): boolean {
  if (typeof s !== "string") return false;
  if (!s.startsWith("eyJ")) return false;
  return s.split(".").length === 3;
}
