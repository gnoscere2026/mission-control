import sodium from "libsodium-wrappers";

// libsodium sealed box over OAuth token JSON (ARCHITECTURE §8.3). The key is a
// base64 32-byte seed in TOKEN_SEAL_KEY; the curve25519 keypair is derived from
// it on every call and never stored. KMS slots in behind this same interface.
async function keypairFrom(seedB64: string | undefined): Promise<sodium.KeyPair> {
  await sodium.ready;
  if (!seedB64) throw new Error("TOKEN_SEAL_KEY is not set");
  let seed: Uint8Array;
  try {
    seed = sodium.from_base64(seedB64, sodium.base64_variants.ORIGINAL);
  } catch {
    throw new Error("TOKEN_SEAL_KEY is not valid base64");
  }
  if (seed.length !== sodium.crypto_box_SEEDBYTES) {
    throw new Error(`TOKEN_SEAL_KEY must decode to ${sodium.crypto_box_SEEDBYTES} bytes`);
  }
  return sodium.crypto_box_seed_keypair(seed);
}

export async function sealToken(
  plain: string,
  key: string | undefined = process.env.TOKEN_SEAL_KEY,
): Promise<string> {
  const kp = await keypairFrom(key);
  return sodium.to_base64(
    sodium.crypto_box_seal(sodium.from_string(plain), kp.publicKey),
    sodium.base64_variants.ORIGINAL,
  );
}

export async function unsealToken(
  sealed: string,
  key: string | undefined = process.env.TOKEN_SEAL_KEY,
): Promise<string> {
  const kp = await keypairFrom(key);
  const opened = sodium.crypto_box_seal_open(
    sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL),
    kp.publicKey,
    kp.privateKey,
  );
  return sodium.to_string(opened);
}
