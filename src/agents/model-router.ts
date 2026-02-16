import type { OpenClawConfig } from "../config/config.js";
import type { ModelAliasIndex } from "./model-selection.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveApiKeyForProvider } from "./model-auth.js";
import { resolveModelRefFromString, type ModelRef } from "./model-selection.js";

const log = createSubsystemLogger("model-router");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelTier = "mini" | "mid" | "high" | "max";

export type RouterRule = {
  /** Regex pattern to match against the message body. */
  pattern: string;
  /** Model tier to use when this rule matches. */
  tier: ModelTier;
  /** Regex flags (default: "i" for case-insensitive). */
  flags?: string;
};

export type RouterConfig = {
  /** Whether the router is enabled (default: false). */
  enabled?: boolean;
  /** Custom routing rules (regex → tier). Evaluated in order; first match wins. */
  rules?: RouterRule[];
  /** Model used for the LLM classifier fallback (default: "openai/gpt-5-mini"). */
  classifierModel?: string;
  /** Mapping of tier names to provider/model strings. */
  tiers?: Partial<Record<ModelTier, string>>;
  /** Timeout in milliseconds for the classifier LLM call (default: 3000). */
  classifierTimeoutMs?: number;
  /**
   * Minimum message length (chars) before the LLM classifier is invoked.
   * Messages shorter than this skip the classifier and use the default model.
   * Only high/max rule matches can escalate short messages. Default: 80.
   */
  classifierMinLength?: number;
};

export type RouteResult = {
  provider: string;
  model: string;
  tier: ModelTier;
  source: "rule" | "classifier" | "default";
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_TIERS = new Set<ModelTier>(["mini", "mid", "high", "max"]);
const DEFAULT_CLASSIFIER_MODEL = "openai/gpt-5-mini";
const DEFAULT_CLASSIFIER_TIMEOUT_MS = 3_000;
const MESSAGE_PREVIEW_MAX_CHARS = 500;

const CLASSIFIER_SYSTEM_PROMPT =
  "You are a message complexity classifier. Reply with exactly one word: mini, mid, high, or max.";

const CLASSIFIER_USER_PROMPT_TEMPLATE = `Classify this user message complexity. Reply with exactly one word.

mini = simple conversation, greetings, status checks, yes/no questions, simple lookups, reading files
mid = multi-step tasks, research, email analysis, task management, scheduling
high = code writing, debugging, documentation, multi-source synthesis, strategic planning
max = architecture design, skill/plugin creation, complex system design, MCP server design

Message: {{MESSAGE}}`;

// ---------------------------------------------------------------------------
// Rule matching (Stage 1)
// ---------------------------------------------------------------------------

type CompiledRule = {
  regex: RegExp;
  tier: ModelTier;
  pattern: string;
};

function compileRules(rules: RouterRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    const pattern = rule.pattern?.trim();
    if (!pattern) {
      continue;
    }
    const tier = rule.tier as ModelTier;
    if (!VALID_TIERS.has(tier)) {
      continue;
    }
    try {
      const flags = rule.flags?.trim() || "i";
      compiled.push({ regex: new RegExp(pattern, flags), tier, pattern });
    } catch {
      log.warn(`model-router: invalid regex pattern: ${pattern}`);
    }
  }
  return compiled;
}

function matchRule(
  message: string,
  rules: CompiledRule[],
): { tier: ModelTier; pattern: string } | null {
  for (const rule of rules) {
    if (rule.regex.test(message)) {
      return { tier: rule.tier, pattern: rule.pattern };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// LLM classifier (Stage 2)
// ---------------------------------------------------------------------------

async function classifyWithLlm(params: {
  message: string;
  classifierModel: string;
  cfg?: OpenClawConfig;
  timeoutMs: number;
}): Promise<ModelTier | null> {
  const preview = params.message.slice(0, MESSAGE_PREVIEW_MAX_CHARS);
  const userPrompt = CLASSIFIER_USER_PROMPT_TEMPLATE.replace("{{MESSAGE}}", preview);

  // Resolve API key for the classifier model's provider.
  const classifierRef = resolveModelRefFromString({
    raw: params.classifierModel,
    defaultProvider: "openai",
  });
  if (!classifierRef) {
    return null;
  }

  let apiKey: string;
  try {
    const auth = await resolveApiKeyForProvider({
      provider: classifierRef.ref.provider,
      cfg: params.cfg,
    });
    const key = auth.apiKey?.trim();
    if (!key) {
      log.warn("model-router: no API key for classifier provider", {
        provider: classifierRef.ref.provider,
      });
      return null;
    }
    apiKey = key;
  } catch {
    return null;
  }

  // Resolve base URL for the provider.
  const baseUrl = resolveBaseUrl(classifierRef.ref.provider, params.cfg);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: classifierRef.ref.model,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_completion_tokens: 128,
        temperature: 1,
        reasoning_effort: "minimal",
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      console.warn(
        `[model-router] classifier API error status=${res.status} body=${errorBody.slice(0, 500)}`,
      );
      return null;
    }

    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content?.trim().toLowerCase();
    if (content && VALID_TIERS.has(content as ModelTier)) {
      return content as ModelTier;
    }
    // Try to extract a tier word from the response if it's not a clean single word.
    if (content) {
      for (const tier of VALID_TIERS) {
        if (content.includes(tier)) {
          return tier;
        }
      }
    }
    console.warn(`[model-router] classifier returned unexpected response: "${content}"`);
    return null;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      log.warn("model-router: classifier timed out", { timeoutMs: params.timeoutMs });
    } else {
      log.warn("model-router: classifier failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveBaseUrl(provider: string, cfg?: OpenClawConfig): string {
  // Check for explicit provider base URL in config.
  const providers = cfg?.models?.providers as
    | Record<string, { baseUrl?: string } | undefined>
    | undefined;
  const providerConfig = providers?.[provider];
  if (providerConfig?.baseUrl?.trim()) {
    return providerConfig.baseUrl.trim().replace(/\/+$/, "");
  }
  // Fallback defaults by provider.
  if (provider === "anthropic") {
    return "https://api.anthropic.com/v1";
  }
  return "https://api.openai.com/v1";
}

// ---------------------------------------------------------------------------
// Tier → model resolution
// ---------------------------------------------------------------------------

function resolveTierModel(params: {
  tier: ModelTier;
  routerConfig: RouterConfig;
  defaultProvider: string;
  aliasIndex?: ModelAliasIndex;
}): ModelRef | null {
  const tierModelRaw = params.routerConfig.tiers?.[params.tier];
  if (!tierModelRaw?.trim()) {
    return null;
  }
  const resolved = resolveModelRefFromString({
    raw: tierModelRaw,
    defaultProvider: params.defaultProvider,
    aliasIndex: params.aliasIndex,
  });
  return resolved?.ref ?? null;
}

// ---------------------------------------------------------------------------
// Main router entry point
// ---------------------------------------------------------------------------

export async function routeModelForMessage(params: {
  message: string;
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex?: ModelAliasIndex;
}): Promise<RouteResult | null> {
  const routerConfig = params.cfg.agents?.defaults?.router as RouterConfig | undefined;
  if (!routerConfig?.enabled) {
    return null;
  }

  const message = params.message?.trim();
  if (!message) {
    return null;
  }

  const tiers = routerConfig.tiers;
  if (!tiers || Object.keys(tiers).length === 0) {
    return null;
  }

  // Stage 1: Rule-based matching.
  const rules = compileRules(routerConfig.rules ?? []);
  const ruleMatch = matchRule(message, rules);
  if (ruleMatch) {
    // For mini/mid rule matches, use the default model (no escalation needed).
    // Only escalate for high/max rule matches.
    if (ruleMatch.tier === "mini" || ruleMatch.tier === "mid") {
      log.info("model-router: rule matched low tier, using default", {
        tier: ruleMatch.tier,
        pattern: ruleMatch.pattern,
      });
      return null;
    }

    const ref = resolveTierModel({
      tier: ruleMatch.tier,
      routerConfig,
      defaultProvider: params.defaultProvider,
      aliasIndex: params.aliasIndex,
    });
    if (ref) {
      log.info("model-router: escalated", {
        tier: ruleMatch.tier,
        source: "rule",
        pattern: ruleMatch.pattern,
        model: `${ref.provider}/${ref.model}`,
      });
      return {
        provider: ref.provider,
        model: ref.model,
        tier: ruleMatch.tier,
        source: "rule",
      };
    }
  }

  // Stage 2: LLM classifier — only for messages that are long/complex enough.
  // Short messages use the default model directly (no classifier cost).
  const classifierMinLength = routerConfig.classifierMinLength ?? 80;
  if (message.length < classifierMinLength) {
    log.info("model-router: short message, using default", {
      length: message.length,
      threshold: classifierMinLength,
    });
    return null;
  }

  const classifierModel = routerConfig.classifierModel?.trim() || DEFAULT_CLASSIFIER_MODEL;
  const timeoutMs = routerConfig.classifierTimeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS;
  const classifiedTier = await classifyWithLlm({
    message,
    classifierModel,
    cfg: params.cfg,
    timeoutMs,
  });

  if (classifiedTier) {
    // Only escalate for high/max. Mini/mid classification means the default model is fine.
    if (classifiedTier === "mini" || classifiedTier === "mid") {
      log.info("model-router: classifier says low tier, using default", {
        tier: classifiedTier,
      });
      return null;
    }

    const ref = resolveTierModel({
      tier: classifiedTier,
      routerConfig,
      defaultProvider: params.defaultProvider,
      aliasIndex: params.aliasIndex,
    });
    if (ref) {
      log.info("model-router: escalated", {
        tier: classifiedTier,
        source: "classifier",
        model: `${ref.provider}/${ref.model}`,
      });
      return {
        provider: ref.provider,
        model: ref.model,
        tier: classifiedTier,
        source: "classifier",
      };
    }
  }

  // Fallback: return null to use the default model.
  log.info("model-router: using default model", {
    source: "default",
    model: `${params.defaultProvider}/${params.defaultModel}`,
  });
  return null;
}
