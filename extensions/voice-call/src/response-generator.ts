/**
 * Voice call response generator - uses the embedded Pi agent for tool support.
 * Routes voice responses through the same agent infrastructure as messaging.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { VoiceCallConfig } from "./config.js";
import { loadCoreAgentDeps, type CoreConfig } from "./core-bridge.js";

// ---------------------------------------------------------------------------
// Caller Trust Tiers
// ---------------------------------------------------------------------------

export type TrustTier = "owner" | "trusted" | "friend" | "stranger";

type FriendEntry = {
  name?: string;
  phone?: string | null;
  relationship?: string;
};

type FriendsFile = {
  friends?: Record<string, FriendEntry>;
};

/**
 * Resolve the caller's trust tier based on their phone number.
 *
 * Priority:
 *  1. Matches ownerNumber (or toNumber fallback) → "owner"
 *  2. Matches a friends.json entry with relationship containing "wife" → "trusted"
 *  3. Matches any friends.json entry → "friend"
 *  4. Unknown number → "stranger"
 */
export function resolveTrustTier(params: {
  from: string;
  ownerNumber: string | undefined;
  workspaceDir: string;
}): { tier: TrustTier; callerName: string | undefined } {
  const { from, ownerNumber, workspaceDir } = params;
  const normalizedFrom = from.replace(/\D/g, "");

  // 1. Owner check
  if (ownerNumber) {
    const normalizedOwner = ownerNumber.replace(/\D/g, "");
    if (normalizedFrom === normalizedOwner) {
      return { tier: "owner", callerName: undefined };
    }
  }

  // 2-3. Check friends.json
  const friendsPath = path.join(workspaceDir, "friends.json");
  let friends: FriendsFile | undefined;
  try {
    const raw = fs.readFileSync(friendsPath, "utf8");
    friends = JSON.parse(raw) as FriendsFile;
  } catch {
    // friends.json not found or invalid — treat as stranger
  }

  if (friends?.friends) {
    for (const entry of Object.values(friends.friends)) {
      if (!entry.phone) continue;
      const normalizedFriendPhone = entry.phone.replace(/\D/g, "");
      if (normalizedFrom !== normalizedFriendPhone) continue;

      // Matched a friend — check if trusted (wife)
      const rel = (entry.relationship ?? "").toLowerCase();
      if (rel.includes("wife") || rel.includes("spouse") || rel.includes("partner")) {
        return { tier: "trusted", callerName: entry.name };
      }
      return { tier: "friend", callerName: entry.name };
    }
  }

  // 4. Unknown
  return { tier: "stranger", callerName: undefined };
}

/**
 * Build a tier-appropriate system prompt for voice calls.
 */
function buildTierSystemPrompt(params: {
  tier: TrustTier;
  agentName: string;
  callerName: string | undefined;
  from: string;
}): string {
  const { tier, agentName, callerName, from } = params;

  switch (tier) {
    case "owner":
      return `You are ${agentName}, Sean's AI assistant on a phone call. Use tools freely for any request. Keep responses conversational but don't hold back on capabilities. The caller's phone number is ${from}.`;
    case "trusted":
      return `You are ${agentName} on a phone call with ${callerName ?? "a trusted contact"}. You can use tools, but confirm any financial actions before executing. Don't share sensitive personal data unprompted. The caller's phone number is ${from}.`;
    case "friend":
      return `You are ${agentName} on a phone call with ${callerName ?? "a friend"}. Be friendly and helpful with general conversation. You cannot execute financial transactions, send emails, or access private data. If they ask for something you can't do, suggest they ask Sean directly. The caller's phone number is ${from}.`;
    case "stranger":
      return `You are ${agentName}. This is an unknown caller. Be polite but guarded. Do not use tools or share any personal information. Keep it brief. If they need something, suggest they contact Sean directly. The caller's phone number is ${from}.`;
  }
}

export type VoiceResponseParams = {
  /** Voice call config */
  voiceConfig: VoiceCallConfig;
  /** Core OpenClaw config */
  coreConfig: CoreConfig;
  /** Call ID for session tracking */
  callId: string;
  /** Caller's phone number */
  from: string;
  /** Conversation transcript */
  transcript: Array<{ speaker: "user" | "bot"; text: string }>;
  /** Latest user message */
  userMessage: string;
};

export type VoiceResponseResult = {
  text: string | null;
  error?: string;
};

type SessionEntry = {
  sessionId: string;
  updatedAt: number;
};

/**
 * Generate a voice response using the embedded Pi agent with full tool support.
 * Uses the same agent infrastructure as messaging for consistent behavior.
 */
export async function generateVoiceResponse(
  params: VoiceResponseParams,
): Promise<VoiceResponseResult> {
  const { voiceConfig, callId, from, transcript, userMessage, coreConfig } = params;

  if (!coreConfig) {
    return { text: null, error: "Core config unavailable for voice response" };
  }

  let deps: Awaited<ReturnType<typeof loadCoreAgentDeps>>;
  try {
    deps = await loadCoreAgentDeps();
  } catch (err) {
    return {
      text: null,
      error: err instanceof Error ? err.message : "Unable to load core agent dependencies",
    };
  }
  const cfg = coreConfig;

  // Build voice-specific session key based on phone number
  const normalizedPhone = from.replace(/\D/g, "");
  const sessionKey = `voice:${normalizedPhone}`;
  const agentId = "main";

  // Resolve paths
  const storePath = deps.resolveStorePath(cfg.session?.store, { agentId });
  const agentDir = deps.resolveAgentDir(cfg, agentId);
  const workspaceDir = deps.resolveAgentWorkspaceDir(cfg, agentId);

  // Ensure workspace exists
  await deps.ensureAgentWorkspace({ dir: workspaceDir });

  // Load or create session entry
  const sessionStore = deps.loadSessionStore(storePath);
  const now = Date.now();
  let sessionEntry = sessionStore[sessionKey] as SessionEntry | undefined;

  if (!sessionEntry) {
    sessionEntry = {
      sessionId: crypto.randomUUID(),
      updatedAt: now,
    };
    sessionStore[sessionKey] = sessionEntry;
    await deps.saveSessionStore(storePath, sessionStore);
  }

  const sessionId = sessionEntry.sessionId;
  const sessionFile = deps.resolveSessionFilePath(sessionId, sessionEntry, {
    agentId,
  });

  // Resolve model from config
  const modelRef = voiceConfig.responseModel || `${deps.DEFAULT_PROVIDER}/${deps.DEFAULT_MODEL}`;
  const slashIndex = modelRef.indexOf("/");
  const provider = slashIndex === -1 ? deps.DEFAULT_PROVIDER : modelRef.slice(0, slashIndex);
  const model = slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1);

  // Resolve thinking level
  const thinkLevel = deps.resolveThinkingDefault({ cfg, provider, model });

  // Resolve agent identity for personalized prompt
  const identity = deps.resolveAgentIdentity(cfg, agentId);
  const agentName = identity?.name?.trim() || "assistant";

  // Resolve caller trust tier
  const ownerNumber = voiceConfig.ownerNumber ?? voiceConfig.toNumber;
  const { tier, callerName } = resolveTrustTier({
    from,
    ownerNumber,
    workspaceDir,
  });

  // Build system prompt with conversation history
  // IMPORTANT: Include explicit instruction to never use NO_REPLY on voice calls.
  // The base agent system prompt tells the model to respond with NO_REPLY when it
  // has "nothing to say", but on a voice call the user always expects a spoken response.
  const tierPrompt = buildTierSystemPrompt({ tier, agentName, callerName, from });
  const basePrompt =
    voiceConfig.responseSystemPrompt ??
    `${tierPrompt}

IMPORTANT: This is a live voice call. You MUST always reply with a spoken response. Never respond with NO_REPLY or stay silent — the caller is waiting to hear you speak. Even if the caller's message is simple (like "hello" or "hey"), respond naturally.`;

  let extraSystemPrompt = basePrompt;
  if (transcript.length > 0) {
    const history = transcript
      .map((entry) => `${entry.speaker === "bot" ? "You" : "Caller"}: ${entry.text}`)
      .join("\n");
    extraSystemPrompt = `${basePrompt}\n\nConversation so far:\n${history}`;
  }

  // Resolve timeout
  const timeoutMs = voiceConfig.responseTimeoutMs ?? deps.resolveAgentTimeoutMs({ cfg });
  const runId = `voice:${callId}:${Date.now()}`;

  try {
    const result = await deps.runEmbeddedPiAgent({
      sessionId,
      sessionKey,
      messageProvider: "voice",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: userMessage,
      provider,
      model,
      thinkLevel,
      verboseLevel: "off",
      timeoutMs,
      runId,
      lane: "voice",
      extraSystemPrompt,
      agentDir,
      senderIsOwner: tier === "owner",
      ownerNumbers: ownerNumber ? [ownerNumber] : [],
      disableTools: tier === "stranger",
    });

    // Extract text from payloads
    const payloads = result.payloads ?? [];
    const texts = payloads
      .filter((p) => p.text && !p.isError)
      .map((p) => p.text?.trim())
      .filter(Boolean);

    const text = texts.join(" ") || null;

    if (!text) {
      const errorPayloads = payloads.filter((p) => p.isError);
      console.warn(
        `[voice-call] Agent returned no text (payloads=${payloads.length}, errors=${errorPayloads.length}, aborted=${result.meta?.aborted ?? false})`,
      );
      if (result.meta?.aborted) {
        return { text: null, error: "Response generation was aborted" };
      }
    }

    return { text };
  } catch (err) {
    console.error(`[voice-call] Response generation failed:`, err);
    return { text: null, error: String(err) };
  }
}
