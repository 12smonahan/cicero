import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import type { PluginLogger } from "../../../../src/plugins/types.js";
import type { SecureBrowserConfig } from "../config.js";
import { jsonResult, readStringParam } from "../../../../src/agents/tools/common.js";
import {
  browserNavigate,
  browserAct,
  browserScreenshotAction,
} from "../../../../src/browser/client-actions-core.js";
import { browserStart, browserStatus, browserSnapshot } from "../../../../src/browser/client.js";
import { vaultInject, vaultInjectTotp } from "../vault.js";

const VaultLoginSchema = Type.Object({
  site: Type.String({ description: "Domain to log into (e.g. 'amazon.com')" }),
  vaultItem: Type.Optional(
    Type.String({
      description:
        "1Password item reference. Defaults to the site domain name (e.g. 'amazon'). Can be a full op:// URI.",
    }),
  ),
  loginUrl: Type.Optional(
    Type.String({
      description:
        "Explicit login page URL. If omitted, navigates to https://<site>/login or similar.",
    }),
  ),
  profile: Type.Optional(
    Type.String({ description: "Browser profile to use (default: 'openclaw')" }),
  ),
});

/** Well-known login paths for common sites. */
const LOGIN_PATHS: Record<string, string> = {
  "amazon.com": "https://www.amazon.com/ap/signin",
  "airbnb.com": "https://www.airbnb.com/login",
  "ebay.com": "https://signin.ebay.com/ws/eBayISAPI.dll?SignIn",
  "walmart.com": "https://www.walmart.com/account/login",
  "target.com": "https://www.target.com/account",
  "bestbuy.com": "https://www.bestbuy.com/identity/global/signin",
  "newegg.com": "https://secure.newegg.com/identity/signin",
};

export function createVaultLoginTool(opts: {
  config: SecureBrowserConfig;
  logger: PluginLogger;
}): AnyAgentTool {
  const { config, logger } = opts;

  return {
    name: "vault_login",
    label: "Vault Login",
    description: [
      "Securely log into a website using credentials from your 1Password vault.",
      "Credentials are injected directly into the browser and NEVER appear in the conversation.",
      "Use this instead of manually typing passwords. Supports 2FA/TOTP if configured in 1Password.",
      'Example: vault_login({ site: "amazon.com" })',
    ].join(" "),
    parameters: VaultLoginSchema,

    async execute(_toolCallId, args) {
      const params = args as Record<string, unknown>;
      const site = readStringParam(params, "site", { required: true });
      const vaultItem =
        readStringParam(params, "vaultItem") ?? site.replace(/\.com$|\.org$|\.net$/, "");
      const loginUrl = readStringParam(params, "loginUrl");
      const profile = readStringParam(params, "profile") ?? "openclaw";

      try {
        // Ensure browser is running
        const status = await browserStatus(undefined, { profile });
        if (!status.running) {
          await browserStart(undefined, { profile });
        }

        // Navigate to login page
        const targetUrl = loginUrl ?? LOGIN_PATHS[site] ?? `https://www.${site}/login`;

        logger.info(`vault_login: navigating to ${targetUrl}`);
        await browserNavigate(undefined, { url: targetUrl, profile });

        // Wait briefly for page to settle
        await sleep(1500);

        // Inject credentials directly into the page
        logger.info(`vault_login: injecting credentials for "${vaultItem}"`);
        await vaultInject({
          itemRef: vaultItem,
          baseUrl: undefined,
          profile,
          vaultPrefix: config.vaultPrefix,
          logger,
        });

        // Submit the login form
        const snap = await browserSnapshot(undefined, { format: "aria", profile });
        if (snap.ok && snap.format === "aria") {
          const submitButton = snap.nodes.find(
            (n) =>
              (n.role === "button" || n.role === "link") &&
              /sign.?in|log.?in|submit|continue|next/i.test(n.name),
          );
          if (submitButton) {
            await browserAct(undefined, { kind: "click", ref: submitButton.ref }, { profile });
          }
        }

        // Wait for login to process
        await sleep(3000);

        // Check for 2FA prompt and handle it
        const postLoginSnap = await browserSnapshot(undefined, { format: "aria", profile });
        if (postLoginSnap.ok && postLoginSnap.format === "aria") {
          const has2faPrompt = postLoginSnap.nodes.some(
            (n) =>
              n.role === "textbox" &&
              /code|otp|totp|verify|authenticat|2fa|mfa|one.?time/i.test(
                n.name + (n.description ?? ""),
              ),
          );

          if (has2faPrompt) {
            logger.info("vault_login: 2FA prompt detected, injecting TOTP code");
            const totpResult = await vaultInjectTotp({
              itemRef: vaultItem,
              baseUrl: undefined,
              profile,
              vaultPrefix: config.vaultPrefix,
              logger,
            });

            if (totpResult.filled) {
              // Submit the 2FA form
              const totpSnap = await browserSnapshot(undefined, { format: "aria", profile });
              if (totpSnap.ok && totpSnap.format === "aria") {
                const verifyButton = totpSnap.nodes.find(
                  (n) =>
                    (n.role === "button" || n.role === "link") &&
                    /verify|submit|continue|confirm|next/i.test(n.name),
                );
                if (verifyButton) {
                  await browserAct(
                    undefined,
                    { kind: "click", ref: verifyButton.ref },
                    { profile },
                  );
                }
              }
              await sleep(2000);
            } else {
              return jsonResult({
                success: false,
                loggedIn: false,
                error: "2FA was prompted but no TOTP secret is configured for this vault item",
              });
            }
          }
        }

        // SECURITY: Return only success/failure — never credential values
        return jsonResult({
          success: true,
          loggedIn: true,
          site,
          profile,
        });
      } catch (err) {
        return jsonResult({
          success: false,
          loggedIn: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
