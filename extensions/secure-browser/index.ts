import type { OpenClawPluginApi, OpenClawPluginDefinition } from "../../src/plugins/types.js";
import { parseSecureBrowserConfig, secureBrowserPluginConfigSchema } from "./src/config.js";
import { createBrowserGuardHandler, createUrlTracker } from "./src/hooks/browser-guard.js";
import { createConfirmActionTool, resolveApproval } from "./src/tools/confirm-action.js";
import { createVaultFillTool } from "./src/tools/vault-fill.js";
import { createVaultLoginTool } from "./src/tools/vault-login.js";

const plugin: OpenClawPluginDefinition = {
  id: "secure-browser",
  name: "Secure Browser Actions",
  description:
    "1Password vault integration for secure logins, form fills, and human-in-the-loop purchase approval via Telegram",
  version: "1.0.0",
  configSchema: secureBrowserPluginConfigSchema,

  register(api: OpenClawPluginApi) {
    const config = parseSecureBrowserConfig(api.pluginConfig);

    if (!config.enabled) {
      api.logger.info("secure-browser: plugin disabled in config");
      return;
    }

    // Check for required env var early (warn, don't crash)
    if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) {
      api.logger.warn(
        "secure-browser: OP_SERVICE_ACCOUNT_TOKEN is not set. vault_login and vault_fill will fail at runtime.",
      );
    }

    const logger = api.logger;

    // -----------------------------------------------------------------------
    // Register tools
    // -----------------------------------------------------------------------

    // vault_login — securely log into sites via 1Password
    api.registerTool(
      (ctx) => {
        if (ctx.sandboxed) return null;
        return createVaultLoginTool({ config, logger });
      },
      { optional: true },
    );

    // vault_fill — securely fill form fields from 1Password
    api.registerTool(
      (ctx) => {
        if (ctx.sandboxed) return null;
        return createVaultFillTool({ config, logger });
      },
      { optional: true },
    );

    // confirm_action — approval gate for purchases/financial actions
    api.registerTool(
      (ctx) => {
        if (ctx.sandboxed) return null;
        return createConfirmActionTool({ config, logger });
      },
      { optional: true },
    );

    // -----------------------------------------------------------------------
    // Register hooks
    // -----------------------------------------------------------------------

    // URL tracker — keeps track of the browser's current URL across tool calls
    const urlTracker = createUrlTracker();

    api.on("after_tool_call", (event, _ctx) => {
      urlTracker.handler(event);
    });

    // Browser guard — intercepts purchase-like actions on sensitive domains
    const guardHandler = createBrowserGuardHandler({
      config,
      logger,
      getCurrentUrl: urlTracker.getCurrentUrl,
    });

    api.on("before_tool_call", guardHandler, { priority: 10 });

    // -----------------------------------------------------------------------
    // Register /approve command for resolving pending approvals
    // -----------------------------------------------------------------------

    api.registerCommand({
      name: "approve",
      description: "Approve or deny a pending secure-browser action (usage: /approve <id> yes|no)",
      acceptsArgs: true,
      handler: (ctx) => {
        const parts = (ctx.args ?? "").trim().split(/\s+/);
        const approvalId = parts[0];
        const decision = parts[1]?.toLowerCase();

        if (!approvalId) {
          return { text: "Usage: /approve <id> yes|no" };
        }

        const approved = decision === "yes" || decision === "y" || decision === "approve";
        const resolved = resolveApproval(approvalId, approved);

        if (!resolved) {
          return {
            text: `No pending approval found with ID "${approvalId}". It may have already expired.`,
          };
        }

        return {
          text: approved ? `Approved action ${approvalId}.` : `Denied action ${approvalId}.`,
        };
      },
    });

    logger.info(
      "secure-browser: plugin registered (vault_login, vault_fill, confirm_action, browser-guard hook)",
    );
  },
};

export default plugin;
