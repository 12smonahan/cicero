import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import type { PluginLogger } from "../../../../src/plugins/types.js";
import type { SecureBrowserConfig } from "../config.js";
import { jsonResult, readStringParam } from "../../../../src/agents/tools/common.js";
import { browserScreenshotAction } from "../../../../src/browser/client-actions-core.js";
import { loadConfig } from "../../../../src/config/config.js";
import { deliverOutboundPayloads } from "../../../../src/infra/outbound/deliver.js";

const ConfirmActionSchema = Type.Object({
  action: Type.String({
    description: 'Short description of the action to confirm (e.g. "Purchase 2 items on Amazon")',
  }),
  details: Type.String({
    description:
      "Detailed summary including items, prices, totals, and any relevant info for the user to review",
  }),
  screenshot: Type.Optional(
    Type.Boolean({
      description:
        "Take a screenshot of the current browser state to include with the approval request (default: true)",
    }),
  ),
  profile: Type.Optional(
    Type.String({ description: "Browser profile to screenshot (default: 'openclaw')" }),
  ),
});

// ---------------------------------------------------------------------------
// Pending approval tracking
// ---------------------------------------------------------------------------

type PendingApproval = {
  id: string;
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
};

const pendingApprovals = new Map<string, PendingApproval>();

/**
 * Called externally (e.g. from a /approve command handler) to resolve a
 * pending approval.
 */
export function resolveApproval(approvalId: string, approved: boolean): boolean {
  const entry = pendingApprovals.get(approvalId);
  if (!entry) return false;

  clearTimeout(entry.timeout);
  pendingApprovals.delete(approvalId);
  entry.resolve(approved);
  return true;
}

/** Returns a list of currently pending approval IDs (for status commands). */
export function listPendingApprovals(): string[] {
  return [...pendingApprovals.keys()];
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createConfirmActionTool(opts: {
  config: SecureBrowserConfig;
  logger: PluginLogger;
}): AnyAgentTool {
  const { config, logger } = opts;

  return {
    name: "confirm_action",
    label: "Confirm Action",
    description: [
      "Request user approval before performing a sensitive action (e.g. a purchase).",
      "Sends a screenshot and summary to the user via Telegram, then waits for approval.",
      "Use this before completing any checkout, payment, or financial transaction.",
      "Returns { approved: true/false }. If denied or timed out, do NOT proceed with the action.",
    ].join(" "),
    parameters: ConfirmActionSchema,

    async execute(_toolCallId, args) {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const details = readStringParam(params, "details", { required: true });
      const takeScreenshot = params.screenshot !== false;
      const profile = readStringParam(params, "profile") ?? "openclaw";

      const approvalId = crypto.randomUUID().slice(0, 8);

      try {
        // Build the approval message
        const lines: string[] = [
          `🛒 Action approval required`,
          `ID: ${approvalId}`,
          "",
          `**Action:** ${action}`,
          "",
          details,
          "",
          `Reply: /approve ${approvalId} yes  or  /approve ${approvalId} no`,
          `Expires in ${config.approvalTimeout}s`,
        ];
        const text = lines.join("\n");

        // Take a screenshot if requested
        let screenshotPath: string | undefined;
        if (takeScreenshot) {
          try {
            const result = await browserScreenshotAction(undefined, {
              fullPage: false,
              type: "jpeg",
              profile,
            });
            if (result.ok) {
              screenshotPath = result.path;
            }
          } catch (err) {
            logger.warn(
              `confirm_action: screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Deliver approval request to the configured channel
        const cfg = loadConfig();
        const channel = config.approvalChannel as "telegram";

        // Resolve the approval target from the exec approval config
        const targets = cfg.approvals?.exec?.targets ?? [];
        const target = targets.find(
          (t) => t.channel === channel || t.channel === config.approvalChannel,
        );

        if (!target) {
          return jsonResult({
            approved: false,
            error: `No approval target configured for channel "${channel}". Add a target to approvals.exec.targets in openclaw.json.`,
          });
        }

        // Build payloads — text message, optionally with screenshot
        const payloads: Array<{ text?: string; media?: Array<{ url: string; mime?: string }> }> =
          [];

        if (screenshotPath) {
          payloads.push({
            text,
            media: [{ url: screenshotPath, mime: "image/jpeg" }],
          });
        } else {
          payloads.push({ text });
        }

        await deliverOutboundPayloads({
          cfg,
          channel,
          to: target.to,
          accountId: target.accountId,
          threadId: target.threadId,
          payloads,
          bestEffort: true,
        });

        logger.info(
          `confirm_action: sent approval request ${approvalId} to ${channel}:${target.to}`,
        );

        // Wait for user response
        const approved = await waitForApproval(approvalId, config.approvalTimeout * 1000);

        // Notify the user of the result
        const resultText = approved
          ? `✅ Action approved: ${action}`
          : `❌ Action denied/timed out: ${action}`;

        await deliverOutboundPayloads({
          cfg,
          channel,
          to: target.to,
          accountId: target.accountId,
          threadId: target.threadId,
          payloads: [{ text: resultText }],
          bestEffort: true,
        }).catch(() => {
          // Best effort — don't fail the tool if notification delivery fails
        });

        return jsonResult({ approved, approvalId });
      } catch (err) {
        return jsonResult({
          approved: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForApproval(approvalId: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      pendingApprovals.delete(approvalId);
      resolve(false);
    }, timeoutMs);

    pendingApprovals.set(approvalId, { id: approvalId, resolve, timeout });
  });
}
