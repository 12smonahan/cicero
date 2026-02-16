import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
  PluginLogger,
} from "../../../../src/plugins/types.js";
import type { SecureBrowserConfig } from "../config.js";

/**
 * Purchase-related keywords used to detect checkout/buy actions.
 * These are matched against the `request.ref`, `request.text`, and snapshot
 * node names from browser `act` calls on sensitive domains.
 */
const PURCHASE_KEYWORDS =
  /place.?order|buy.?now|checkout|complete.?purchase|confirm.?order|pay.?now|submit.?order|proceed.?to.?pay|place.?your.?order|purchase|add.?to.?cart.?and.?checkout/i;

/**
 * Checks whether a URL belongs to one of the configured sensitive domains.
 */
function isSensitiveDomain(url: string, domains: string[]): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return domains.some((domain) => {
      const d = domain.toLowerCase();
      return hostname === d || hostname === `www.${d}` || hostname.endsWith(`.${d}`);
    });
  } catch {
    // If the URL is malformed, match on substring as fallback
    const lower = url.toLowerCase();
    return domains.some((d) => lower.includes(d.toLowerCase()));
  }
}

/**
 * Extracts actionable text from a browser tool's `act` request params to
 * check for purchase-related intent.
 */
function extractActText(params: Record<string, unknown>): string {
  const parts: string[] = [];
  const request = params.request as Record<string, unknown> | undefined;
  if (request) {
    if (typeof request.text === "string") parts.push(request.text);
    if (typeof request.ref === "string") parts.push(request.ref);
    if (typeof request.key === "string") parts.push(request.key);
  }
  // Also check top-level params that some callers might use
  if (typeof params.targetUrl === "string") parts.push(params.targetUrl);
  return parts.join(" ");
}

/**
 * Creates a `before_tool_call` hook handler that intercepts browser actions
 * on sensitive domains when purchase-related keywords are detected.
 *
 * When triggered, it blocks the browser action and tells the agent to use
 * `confirm_action` first.
 */
export function createBrowserGuardHandler(opts: {
  config: SecureBrowserConfig;
  logger: PluginLogger;
  /** Getter for the current page URL from the browser state. */
  getCurrentUrl?: () => string | null;
}): (
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
) => Promise<PluginHookBeforeToolCallResult | void> {
  const { config, logger } = opts;

  // Track the last known URL from browser navigate/snapshot results.
  // This is updated via the after_tool_call hook in the main index.
  let lastKnownUrl: string | null = null;

  return async (event, _ctx) => {
    // Only intercept the `browser` tool
    if (event.toolName !== "browser") return;

    const params = event.params;
    const action = typeof params.action === "string" ? params.action : "";

    // Track navigation URLs
    if (action === "navigate" && typeof params.targetUrl === "string") {
      lastKnownUrl = params.targetUrl;
    }

    // We only guard `act` actions (clicks, form submissions, etc.)
    if (action !== "act") return;

    // Check if the current page is on a sensitive domain
    const currentUrl = opts.getCurrentUrl?.() ?? lastKnownUrl;
    if (!currentUrl) return;
    if (!isSensitiveDomain(currentUrl, config.sensitiveDomains)) return;

    // Check if the action looks like a purchase
    const actText = extractActText(params);
    if (!PURCHASE_KEYWORDS.test(actText)) return;

    logger.info(
      `browser-guard: blocking purchase-like action on ${currentUrl} — agent must use confirm_action first`,
    );

    return {
      block: true,
      blockReason: [
        "This action looks like a purchase or financial transaction on a sensitive domain.",
        "You must call confirm_action first to get user approval before proceeding.",
        "Send a screenshot and summary of what you're about to do, then wait for the user's response.",
      ].join(" "),
    };
  };
}

/**
 * Creates an `after_tool_call` handler that tracks the current browser URL
 * from navigate and snapshot results.
 */
export function createUrlTracker(): {
  handler: (event: { toolName: string; params: Record<string, unknown>; result?: unknown }) => void;
  getCurrentUrl: () => string | null;
} {
  let currentUrl: string | null = null;

  const handler = (event: {
    toolName: string;
    params: Record<string, unknown>;
    result?: unknown;
  }) => {
    if (event.toolName !== "browser") return;

    const action = typeof event.params.action === "string" ? event.params.action : "";
    const result = event.result as Record<string, unknown> | undefined;

    if (action === "navigate" && typeof event.params.targetUrl === "string") {
      currentUrl = event.params.targetUrl;
    }

    // Extract URL from tool results
    if (result && typeof result.url === "string") {
      currentUrl = result.url;
    }
  };

  return { handler, getCurrentUrl: () => currentUrl };
}
