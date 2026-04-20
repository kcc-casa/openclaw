import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeWebhookEvent } from "./monitor-event-normalize.js";

function readFixture(name: string) {
  const fixturePath = path.join(import.meta.dirname, "test-fixtures", name);
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
}

describe("normalizeWebhookEvent", () => {
  it("classifies typing-indicator payloads", () => {
    const result = normalizeWebhookEvent(readFixture("typing-indicator.self-chat.json"));

    expect(result).toEqual({
      kind: "typing",
      typing: {
        chatGuid: "iMessage;-;+15551234567",
        display: false,
      },
    });
  });

  it("preserves outbound self-chat messages as fromMe true", () => {
    const result = normalizeWebhookEvent(
      readFixture("new-message.self-chat.outbound-trading.json"),
    );

    expect(result.kind).toBe("message");
    if (result.kind !== "message") {
      return;
    }
    expect(result.message.text).toBe("Trading");
    expect(result.message.senderId).toBe("+15551234567");
    expect(result.message.chatGuid).toBe("iMessage;-;+15551234567");
    expect(result.message.fromMe).toBe(true);
  });

  it("preserves inbound self-chat messages as fromMe false", () => {
    const result = normalizeWebhookEvent(readFixture("new-message.self-chat.inbound-trading.json"));

    expect(result.kind).toBe("message");
    if (result.kind !== "message") {
      return;
    }
    expect(result.message.text).toBe("Trading");
    expect(result.message.senderId).toBe("+15551234567");
    expect(result.message.chatGuid).toBe("iMessage;-;+15551234567");
    expect(result.message.fromMe).toBe(false);
  });

  it("classifies string tapback payloads as reactions", () => {
    const result = normalizeWebhookEvent(readFixture("new-message.tapback.like.json"));

    expect(result.kind).toBe("reaction");
    if (result.kind !== "reaction") {
      return;
    }
    expect(result.reaction.senderId).toBe("person@example.test");
    expect(result.reaction.action).toBe("added");
    expect(result.reaction.emoji).toBe("👍");
    expect(result.reaction.messageId).toBe("p:0/AAAA1111-BBBB-4CCC-8DDD-EEEEFFFF0000");
  });

  it("ignores chat-read-status-changed payloads", () => {
    const result = normalizeWebhookEvent(readFixture("chat-read-status-changed.json"));

    expect(result).toEqual({
      kind: "ignored",
      reason: "chat-read-status-changed",
    });
  });

  it("keeps image text messages as normal messages with attachments", () => {
    const result = normalizeWebhookEvent(readFixture("new-message.image-with-text.json"));

    expect(result.kind).toBe("message");
    if (result.kind !== "message") {
      return;
    }
    expect(result.message.text).toBe("Oh my that seems so long!");
    expect(result.message.attachments).toHaveLength(1);
    expect(result.message.attachments?.[0]?.mimeType).toBe("image/png");
  });

  it("fills placeholder text for attachment-only image messages", () => {
    const result = normalizeWebhookEvent(readFixture("new-message.attachment-only-image.json"));

    expect(result.kind).toBe("message");
    if (result.kind !== "message") {
      return;
    }
    expect(result.message.text).toBe("<media:image> (1 image)");
    expect(result.message.attachments).toHaveLength(1);
  });

  it("fills placeholder text for attachment-only video messages", () => {
    const result = normalizeWebhookEvent(readFixture("new-message.attachment-only-video.json"));

    expect(result.kind).toBe("message");
    if (result.kind !== "message") {
      return;
    }
    expect(result.message.text).toBe("<media:video> (1 video)");
    expect(result.message.attachments).toHaveLength(1);
  });

  it("normalizes direct email handles as sender ids", () => {
    const result = normalizeWebhookEvent(readFixture("new-message.direct-email-handle.json"));

    expect(result.kind).toBe("message");
    if (result.kind !== "message") {
      return;
    }
    expect(result.message.senderId).toBe("person@example.test");
    expect(result.message.chatGuid).toBe("iMessage;-;person@example.test");
  });
});
