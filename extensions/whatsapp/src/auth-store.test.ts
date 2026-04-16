import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  logoutWeb,
  pickWebChannel,
  webAuthExists,
  WhatsAppAuthUnstableError,
  WHATSAPP_AUTH_UNSTABLE_CODE,
} from "./auth-store.js";
import type { CredsQueueWaitResult } from "./creds-persistence.js";

const hoisted = vi.hoisted(() => ({
  waitForCredsSaveQueueWithTimeout: vi.fn<() => Promise<CredsQueueWaitResult>>(
    async () => "drained",
  ),
}));

vi.mock("./creds-persistence.js", async () => {
  const actual =
    await vi.importActual<typeof import("./creds-persistence.js")>("./creds-persistence.js");
  return {
    ...actual,
    waitForCredsSaveQueueWithTimeout: hoisted.waitForCredsSaveQueueWithTimeout,
  };
});

function createTempAuthDir(prefix: string) {
  return fsSync.mkdtempSync(
    path.join((process.env.TMPDIR ?? "/tmp").replace(/\/+$/, ""), `${prefix}-`),
  );
}

describe("auth-store", () => {
  beforeEach(() => {
    hoisted.waitForCredsSaveQueueWithTimeout.mockReset().mockResolvedValue("drained");
  });

  it("does not restore creds from backup on ordinary reads", async () => {
    const authDir = createTempAuthDir("openclaw-wa-auth-read");
    const credsPath = path.join(authDir, "creds.json");
    const backupPath = path.join(authDir, "creds.json.bak");
    fsSync.writeFileSync(backupPath, JSON.stringify({ me: { id: "123@s.whatsapp.net" } }), "utf-8");

    await expect(webAuthExists(authDir)).resolves.toBe(false);
    expect(fsSync.existsSync(credsPath)).toBe(false);
  });

  it("clears unreadable auth state on explicit logout", async () => {
    const authDir = createTempAuthDir("openclaw-wa-auth-logout");
    fsSync.writeFileSync(path.join(authDir, "creds.json"), "{", "utf-8");
    fsSync.writeFileSync(
      path.join(authDir, "creds.json.bak"),
      JSON.stringify({ me: { id: "123@s.whatsapp.net" } }),
      "utf-8",
    );

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await expect(logoutWeb({ authDir, runtime: runtime as never })).resolves.toBe(true);
    expect(fsSync.existsSync(authDir)).toBe(false);
  });

  it("clears auth state even when directory enumeration fails", async () => {
    const authDir = createTempAuthDir("openclaw-wa-auth-readdir");
    fsSync.writeFileSync(path.join(authDir, "creds.json"), "{}", "utf-8");
    const readdirSpy = vi
      .spyOn(fs, "readdir")
      .mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await expect(logoutWeb({ authDir, runtime: runtime as never })).resolves.toBe(true);
    expect(fsSync.existsSync(authDir)).toBe(false);
    readdirSpy.mockRestore();
  });

  it("throws a typed unstable-auth error when channel selection times out", async () => {
    hoisted.waitForCredsSaveQueueWithTimeout.mockResolvedValueOnce("timed_out");

    await expect(pickWebChannel("auto", "/tmp/openclaw-wa-auth-unstable")).rejects.toEqual(
      expect.objectContaining({
        code: WHATSAPP_AUTH_UNSTABLE_CODE,
        name: WhatsAppAuthUnstableError.name,
      }),
    );
  });
});
