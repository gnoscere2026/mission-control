import { describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers";
import { sealToken, unsealToken } from "./sealed-box";

async function freshKey(): Promise<string> {
  await sodium.ready;
  return sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL);
}

describe("sealed-box token crypto", () => {
  it("round-trips a token payload", async () => {
    const key = await freshKey();
    const plain = JSON.stringify({ refresh_token: "r1", access_token: "a1" });
    const sealed = await sealToken(plain, key);
    expect(sealed).not.toContain("r1");
    expect(await unsealToken(sealed, key)).toBe(plain);
  });

  it("fails to unseal with a different key", async () => {
    const sealed = await sealToken("secret", await freshKey());
    await expect(unsealToken(sealed, await freshKey())).rejects.toThrow();
  });

  it("rejects a missing key", async () => {
    await expect(sealToken("x", undefined)).rejects.toThrow(/TOKEN_SEAL_KEY/);
  });

  it("rejects a key of the wrong length", async () => {
    await sodium.ready;
    const short = sodium.to_base64(sodium.randombytes_buf(16), sodium.base64_variants.ORIGINAL);
    await expect(sealToken("x", short)).rejects.toThrow(/TOKEN_SEAL_KEY/);
  });
});
