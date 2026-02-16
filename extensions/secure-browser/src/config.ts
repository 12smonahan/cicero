import { z } from "zod";

export const SecureBrowserConfigSchema = z.object({
  enabled: z.boolean().default(true),
  sensitiveDomains: z
    .array(z.string())
    .default([
      "amazon.com",
      "airbnb.com",
      "ebay.com",
      "walmart.com",
      "target.com",
      "bestbuy.com",
      "costco.com",
      "newegg.com",
      "etsy.com",
      "booking.com",
      "expedia.com",
      "venmo.com",
      "paypal.com",
    ]),
  approvalChannel: z.string().default("telegram"),
  approvalTimeout: z.number().int().positive().default(300),
  /** Optional: default vault item prefix for lookups (e.g. "shopping/") */
  vaultPrefix: z.string().optional(),
});

export type SecureBrowserConfig = z.infer<typeof SecureBrowserConfigSchema>;

export function parseSecureBrowserConfig(raw: unknown): SecureBrowserConfig {
  if (!raw || typeof raw !== "object") {
    return SecureBrowserConfigSchema.parse({});
  }
  return SecureBrowserConfigSchema.parse(raw);
}

/**
 * Config schema adapter for the OpenClaw plugin system.
 * Compatible with OpenClawPluginConfigSchema.
 */
export const secureBrowserPluginConfigSchema = {
  safeParse(value: unknown) {
    return SecureBrowserConfigSchema.safeParse(value);
  },
  parse(value: unknown) {
    return SecureBrowserConfigSchema.parse(value);
  },
  uiHints: {
    enabled: { label: "Enabled", help: "Enable the secure browser actions plugin" },
    sensitiveDomains: {
      label: "Sensitive Domains",
      help: "Domains that require purchase approval before browser actions proceed",
    },
    approvalChannel: {
      label: "Approval Channel",
      help: "Channel to send approval requests (e.g. telegram)",
    },
    approvalTimeout: {
      label: "Approval Timeout (s)",
      help: "Seconds to wait for user approval before timing out",
      advanced: true,
    },
    vaultPrefix: {
      label: "Vault Prefix",
      help: "Optional prefix for 1Password item lookups",
      advanced: true,
    },
  },
};
