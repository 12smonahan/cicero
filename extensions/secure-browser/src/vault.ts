import { createClient, type Client } from "@1password/sdk";
import type { BrowserActRequest } from "../../../src/browser/client-actions-core.js";
import type { PluginLogger } from "../../../src/plugins/types.js";
import { browserAct } from "../../../src/browser/client-actions-core.js";
import { browserSnapshot } from "../../../src/browser/client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VaultCredentials = {
  username: string;
  password: string;
  totp?: string;
};

export type VaultFieldMap = Record<string, string>;

// ---------------------------------------------------------------------------
// Singleton 1Password client
// ---------------------------------------------------------------------------

let clientPromise: Promise<Client> | null = null;

export function getClient(): Promise<Client> {
  if (clientPromise) return clientPromise;

  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  if (!token) {
    throw new Error(
      "OP_SERVICE_ACCOUNT_TOKEN is not set. A 1Password service account token is required for vault operations.",
    );
  }

  clientPromise = createClient({
    auth: token,
    integrationName: "OpenClaw Secure Browser",
    integrationVersion: "1.0.0",
  });

  return clientPromise;
}

// ---------------------------------------------------------------------------
// vaultResolve — look up credentials from 1Password
// ---------------------------------------------------------------------------

/**
 * Resolves credentials for a vault item reference.
 *
 * @param itemRef - Item reference like "amazon" or "op://Shopping/amazon"
 * @param opts.vaultPrefix - Optional prefix (e.g. "Shopping/") prepended when
 *   itemRef is a bare name.
 * @returns Credentials (username, password, optional TOTP code).
 *   SECURITY: This function returns raw credentials. Only call from injection
 *   helpers that pipe directly into the browser — never surface results to the
 *   LLM context.
 */
export async function vaultResolve(
  itemRef: string,
  opts?: { vaultPrefix?: string; logger?: PluginLogger },
): Promise<VaultCredentials> {
  const client = await getClient();
  const logger = opts?.logger;

  // Build the secret reference path.
  // If the caller already passed an op:// URI, use it as-is.
  // Otherwise, construct one from the prefix + item name.
  const isFullRef = itemRef.startsWith("op://");
  const basePath = isFullRef ? itemRef : `op://${opts?.vaultPrefix ?? "Private/"}${itemRef}`;

  logger?.info?.(`vault: resolving item "${basePath.replace(/op:\/\//, "")}"`);

  const username = await client.secrets.resolve(`${basePath}/username`);
  const password = await client.secrets.resolve(`${basePath}/password`);

  let totp: string | undefined;
  try {
    totp = await client.secrets.resolve(`${basePath}/one-time password`);
  } catch {
    // TOTP field is optional — many items don't have one
  }

  return { username, password, totp };
}

// ---------------------------------------------------------------------------
// vaultInject — fill credentials directly into the page via browser actions
// ---------------------------------------------------------------------------

/**
 * Resolves credentials from 1Password and fills them into the current browser
 * page. Credentials never leave this function as a return value — they go
 * straight into Playwright via the browser control API.
 *
 * @param opts.itemRef - Vault item reference (e.g. "amazon")
 * @param opts.fieldMap - Maps vault field names to page element refs.
 *   Defaults: { username: <auto-detect>, password: <auto-detect> }
 * @param opts.baseUrl - Browser control server base URL
 * @param opts.profile - Browser profile to use
 * @param opts.vaultPrefix - Optional vault path prefix
 *
 * @returns `{ filled: true }` — never returns the credential values.
 */
export async function vaultInject(opts: {
  itemRef: string;
  fieldMap?: VaultFieldMap;
  baseUrl?: string;
  profile?: string;
  vaultPrefix?: string;
  logger?: PluginLogger;
}): Promise<{ filled: true }> {
  const { itemRef, fieldMap, baseUrl, profile, vaultPrefix, logger } = opts;

  const creds = await vaultResolve(itemRef, { vaultPrefix, logger });

  // If explicit field map is provided, use it. Otherwise try to auto-detect
  // input fields from a page snapshot.
  const usernameRef = fieldMap?.username;
  const passwordRef = fieldMap?.password;

  if (usernameRef && passwordRef) {
    // Explicit refs — fill directly
    await fillField(baseUrl, profile, usernameRef, creds.username);
    await fillField(baseUrl, profile, passwordRef, creds.password);
  } else {
    // Auto-detect: take a snapshot and find email/username + password fields
    const snap = await browserSnapshot(baseUrl, { format: "aria", profile });
    if (!snap.ok) {
      throw new Error("Failed to take page snapshot for credential injection");
    }

    const nodes = snap.format === "aria" ? snap.nodes : [];

    const emailNode = nodes.find(
      (n) =>
        n.role === "textbox" &&
        /email|username|login|user.*name|e-?mail/i.test(n.name + (n.description ?? "")),
    );
    const passwordNode = nodes.find(
      (n) => n.role === "textbox" && /password|passwd|pass/i.test(n.name + (n.description ?? "")),
    );

    if (!emailNode) {
      throw new Error("Could not auto-detect username/email input field on page");
    }
    if (!passwordNode) {
      throw new Error("Could not auto-detect password input field on page");
    }

    await fillField(baseUrl, profile, emailNode.ref, creds.username);
    await fillField(baseUrl, profile, passwordNode.ref, creds.password);
  }

  return { filled: true };
}

// ---------------------------------------------------------------------------
// vaultInjectTotp — resolve and fill a TOTP code
// ---------------------------------------------------------------------------

export async function vaultInjectTotp(opts: {
  itemRef: string;
  totpRef?: string;
  baseUrl?: string;
  profile?: string;
  vaultPrefix?: string;
  logger?: PluginLogger;
}): Promise<{ filled: boolean }> {
  const { itemRef, totpRef, baseUrl, profile, vaultPrefix, logger } = opts;

  const creds = await vaultResolve(itemRef, { vaultPrefix, logger });
  if (!creds.totp) {
    return { filled: false };
  }

  if (totpRef) {
    await fillField(baseUrl, profile, totpRef, creds.totp);
  } else {
    // Auto-detect TOTP/code input
    const snap = await browserSnapshot(baseUrl, { format: "aria", profile });
    if (!snap.ok) {
      throw new Error("Failed to take page snapshot for TOTP injection");
    }
    const nodes = snap.format === "aria" ? snap.nodes : [];
    const codeNode = nodes.find(
      (n) =>
        n.role === "textbox" &&
        /code|otp|totp|verify|authenticat|2fa|mfa|one.?time/i.test(n.name + (n.description ?? "")),
    );
    if (!codeNode) {
      throw new Error("Could not auto-detect TOTP/verification code input field on page");
    }
    await fillField(baseUrl, profile, codeNode.ref, creds.totp);
  }

  return { filled: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fillField(
  baseUrl: string | undefined,
  profile: string | undefined,
  ref: string,
  value: string,
): Promise<void> {
  const req: BrowserActRequest = {
    kind: "type",
    ref,
    text: value,
    submit: false,
  };
  await browserAct(baseUrl, req, { profile });
}
