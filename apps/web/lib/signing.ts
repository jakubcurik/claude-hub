"use server";

import { generateKeyPair, sign as cryptoSign, createPrivateKey, createPublicKey } from "node:crypto";
import { promisify } from "node:util";
import type { CatalogAsset } from "@claude-hub/schema";
import { computeContentHashServerSide } from "@/lib/content-hash";

const generateKeyPairAsync = promisify(generateKeyPair);

export interface GeneratedSigningKey {
  publicKeyBase64: string;
  privateKeyPem: string;
  fingerprint: string;
}

/**
 * Vytvoří Ed25519 keypair. Privátní klíč se vrací ve formátu PEM (uživatel si ho stáhne),
 * veřejný v raw base64 (32 bajtů) — vhodné pro nahrání do API.
 */
export async function generateSigningKey(): Promise<GeneratedSigningKey> {
  const { publicKey, privateKey } = await generateKeyPairAsync("ed25519");

  const publicSpki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPublic = publicSpki.subarray(publicSpki.length - 32);
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const fingerprint = rawPublic.toString("hex").slice(0, 16);

  return {
    publicKeyBase64: rawPublic.toString("base64"),
    privateKeyPem: privatePem,
    fingerprint
  };
}

/**
 * Podepíše asset privátním PEM klíčem. Vrací base64 podpisu a base64 veřejného klíče,
 * kterým daemon i API mohou ověřit.
 */
export async function signAsset(
  privateKeyPem: string,
  asset: CatalogAsset
): Promise<{ signature: string; publicKey: string }> {
  const privateKeyObject = createPrivateKey({ key: privateKeyPem, format: "pem" });
  const publicKeyObject = createPublicKey(privateKeyObject);
  const publicSpki = publicKeyObject.export({ format: "der", type: "spki" }) as Buffer;
  const rawPublic = publicSpki.subarray(publicSpki.length - 32);

  const message = Buffer.from(computeContentHashServerSide(asset), "utf8");
  const signature = cryptoSign(null, message, privateKeyObject);

  return {
    signature: signature.toString("base64"),
    publicKey: rawPublic.toString("base64")
  };
}
