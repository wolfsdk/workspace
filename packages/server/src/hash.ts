/** Lowercase hexadecimal SHA-256, the hash every head, entry and blob of the contracts carries. */
export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
