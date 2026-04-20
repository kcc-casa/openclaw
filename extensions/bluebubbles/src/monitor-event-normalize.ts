import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  buildMessagePlaceholder,
  normalizeWebhookMessage,
  normalizeWebhookReaction,
  type NormalizedWebhookMessage,
  type NormalizedWebhookReaction,
} from "./monitor-normalize.js";

export type NormalizedWebhookTyping = {
  chatGuid?: string;
  display?: boolean;
};

export type NormalizedWebhookEvent =
  | { kind: "message"; message: NormalizedWebhookMessage }
  | { kind: "reaction"; reaction: NormalizedWebhookReaction }
  | { kind: "typing"; typing: NormalizedWebhookTyping }
  | { kind: "ignored"; reason: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeTypingEvent(payload: Record<string, unknown>): NormalizedWebhookTyping | null {
  const eventType = normalizeOptionalString(
    typeof payload.type === "string" ? payload.type : undefined,
  );
  if (eventType !== "typing-indicator") {
    return null;
  }
  const data = asRecord(payload.data);
  return {
    chatGuid: normalizeOptionalString(typeof data?.guid === "string" ? data.guid : undefined),
    display: typeof data?.display === "boolean" ? data.display : undefined,
  };
}

export function normalizeWebhookEvent(payload: Record<string, unknown>): NormalizedWebhookEvent {
  const typing = normalizeTypingEvent(payload);
  if (typing) {
    return { kind: "typing", typing };
  }

  const reaction = normalizeWebhookReaction(payload);
  if (reaction) {
    return { kind: "reaction", reaction };
  }

  const message = normalizeWebhookMessage(payload);
  if (!message) {
    return { kind: "ignored", reason: "unparseable-payload" };
  }

  if (!message.text.trim()) {
    const placeholder = buildMessagePlaceholder(message);
    if (placeholder) {
      return {
        kind: "message",
        message: {
          ...message,
          text: placeholder,
        },
      };
    }
  }

  return { kind: "message", message };
}
