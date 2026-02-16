import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import type { PluginLogger } from "../../../../src/plugins/types.js";
import type { SecureBrowserConfig } from "../config.js";
import { jsonResult, readStringParam } from "../../../../src/agents/tools/common.js";
import { browserAct } from "../../../../src/browser/client-actions-core.js";
import { getClient } from "../vault.js";

const VaultFillSchema = Type.Object({
  vaultItem: Type.String({
    description: '1Password item reference (e.g. "amazon", "my-credit-card", or a full op:// URI)',
  }),
  fields: Type.Record(Type.String(), Type.String(), {
    description: [
      "Maps page element refs (from a browser snapshot) to 1Password field names.",
      'Example: { "e14": "username", "e15": "password", "e20": "credit card number" }',
      "The vault item will be resolved and each field value injected directly into the",
      "corresponding page element. Credentials never appear in the conversation.",
    ].join(" "),
  }),
  profile: Type.Optional(
    Type.String({ description: "Browser profile to use (default: 'openclaw')" }),
  ),
});

/**
 * Maps common human-readable field names to 1Password secret reference
 * field paths. This lets the agent use natural names like "credit card number"
 * while still resolving to the correct 1Password field.
 */
const FIELD_ALIASES: Record<string, string> = {
  "credit card number": "credit card number",
  "card number": "credit card number",
  ccn: "credit card number",
  cvv: "verification number",
  cvc: "verification number",
  "security code": "verification number",
  "expiration date": "expiry date",
  "exp date": "expiry date",
  expiry: "expiry date",
  "card expiry": "expiry date",
  "cardholder name": "cardholder name",
  "name on card": "cardholder name",
  zip: "zip or postal code",
  "postal code": "zip or postal code",
  "zip code": "zip or postal code",
};

function resolveFieldName(name: string): string {
  return FIELD_ALIASES[name.toLowerCase()] ?? name;
}

export function createVaultFillTool(opts: {
  config: SecureBrowserConfig;
  logger: PluginLogger;
}): AnyAgentTool {
  const { config, logger } = opts;

  return {
    name: "vault_fill",
    label: "Vault Fill",
    description: [
      "Fill form fields with data from your 1Password vault.",
      "Use for payment forms, address fields, or any sensitive data entry.",
      "Credentials are injected directly into the browser and NEVER appear in the conversation.",
      "First take a browser snapshot to get element refs, then call this tool with a mapping",
      "of refs to vault field names.",
    ].join(" "),
    parameters: VaultFillSchema,

    async execute(_toolCallId, args) {
      const params = args as Record<string, unknown>;
      const vaultItem = readStringParam(params, "vaultItem", { required: true });
      const fields = params.fields as Record<string, string> | undefined;
      const profile = readStringParam(params, "profile") ?? "openclaw";

      if (!fields || typeof fields !== "object" || Object.keys(fields).length === 0) {
        return jsonResult({
          success: false,
          error:
            "fields is required and must be a non-empty object mapping refs to vault field names",
        });
      }

      try {
        const client = await getClient();

        const isFullRef = vaultItem.startsWith("op://");
        const basePath = isFullRef
          ? vaultItem
          : `op://${config.vaultPrefix ?? "Private/"}${vaultItem}`;

        logger.info(
          `vault_fill: resolving ${Object.keys(fields).length} fields from "${basePath.replace(/op:\/\//, "")}"`,
        );

        let filledCount = 0;
        const errors: string[] = [];

        for (const [ref, fieldName] of Object.entries(fields)) {
          const resolvedField = resolveFieldName(fieldName);
          try {
            const value = await client.secrets.resolve(`${basePath}/${resolvedField}`);
            await browserAct(
              undefined,
              { kind: "type", ref, text: value, submit: false },
              { profile },
            );
            filledCount++;
          } catch (err) {
            errors.push(
              `Field "${fieldName}" (ref ${ref}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // SECURITY: Return only counts — never field values
        return jsonResult({
          success: errors.length === 0,
          filled: filledCount,
          total: Object.keys(fields).length,
          ...(errors.length > 0 ? { errors } : {}),
        });
      } catch (err) {
        return jsonResult({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
