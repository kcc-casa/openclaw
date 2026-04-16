import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { info, success } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { defaultRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveOAuthDir } from "./auth-store.runtime.js";
import { hasWebCredsSync, resolveWebCredsBackupPath, resolveWebCredsPath } from "./creds-files.js";
import {
  waitForCredsSaveQueueWithTimeout,
  type CredsQueueWaitResult,
} from "./creds-persistence.js";
import { resolveComparableIdentity, type WhatsAppSelfIdentity } from "./identity.js";
import { resolveUserPath, type WebChannel } from "./text-runtime.js";
export { hasWebCredsSync, resolveWebCredsBackupPath, resolveWebCredsPath };

export const WHATSAPP_AUTH_UNSTABLE_CODE = "whatsapp-auth-unstable";

const authStoreLogger = getChildLogger({ module: "web-auth-store" });
const emptyWebSelfId = () => ({ e164: null, jid: null, lid: null }) as const;

export class WhatsAppAuthUnstableError extends Error {
  readonly code = WHATSAPP_AUTH_UNSTABLE_CODE;

  constructor(message = "WhatsApp auth state is still stabilizing; retry shortly.") {
    super(message);
    this.name = "WhatsAppAuthUnstableError";
  }
}

export function resolveDefaultWebAuthDir(): string {
  return path.join(resolveOAuthDir(), "whatsapp", DEFAULT_ACCOUNT_ID);
}

export const WA_WEB_AUTH_DIR = resolveDefaultWebAuthDir();

export function readCredsJsonRaw(filePath: string): string | null {
  try {
    if (!fsSync.existsSync(filePath)) {
      return null;
    }
    const stats = fsSync.statSync(filePath);
    if (!stats.isFile() || stats.size <= 1) {
      return null;
    }
    return fsSync.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function waitForWebAuthBarrier(
  authDir: string,
  context: string,
): Promise<CredsQueueWaitResult> {
  const result = await waitForCredsSaveQueueWithTimeout(authDir);
  if (result === "timed_out") {
    authStoreLogger.warn(
      {
        authDir,
        context,
      },
      "timed out waiting for queued WhatsApp creds save before auth read",
    );
  }
  return result;
}

export async function restoreCredsFromBackupIfNeeded(authDir: string): Promise<boolean> {
  const logger = getChildLogger({ module: "web-session" });
  try {
    const credsPath = resolveWebCredsPath(authDir);
    const backupPath = resolveWebCredsBackupPath(authDir);
    const raw = readCredsJsonRaw(credsPath);
    if (raw) {
      // Validate that creds.json is parseable.
      JSON.parse(raw);
      return false;
    }

    const backupRaw = readCredsJsonRaw(backupPath);
    if (!backupRaw) {
      return false;
    }

    // Ensure backup is parseable before restoring.
    JSON.parse(backupRaw);
    await fs.copyFile(backupPath, credsPath);
    await fs.chmod(credsPath, 0o600).catch(() => {
      // best-effort on platforms that support it
    });
    logger.warn({ credsPath }, "restored corrupted WhatsApp creds.json from backup");
    return true;
  } catch {
    // ignore
  }
  return false;
}

export async function webAuthExists(authDir: string = resolveDefaultWebAuthDir()) {
  const resolvedAuthDir = resolveUserPath(authDir);
  const credsPath = resolveWebCredsPath(resolvedAuthDir);
  try {
    await fs.access(resolvedAuthDir);
  } catch {
    return false;
  }
  try {
    const stats = await fs.stat(credsPath);
    if (!stats.isFile() || stats.size <= 1) {
      return false;
    }
    const raw = await fs.readFile(credsPath, "utf-8");
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

export async function readWebAuthExistsBestEffort(authDir: string = resolveDefaultWebAuthDir()) {
  const resolvedAuthDir = resolveUserPath(authDir);
  const result = await waitForWebAuthBarrier(resolvedAuthDir, "readWebAuthExistsBestEffort");
  return {
    exists: await webAuthExists(resolvedAuthDir),
    timedOut: result === "timed_out",
  } as const;
}

export async function readWebAuthExistsForDecision(
  authDir: string = resolveDefaultWebAuthDir(),
): Promise<{ outcome: "stable"; exists: boolean } | { outcome: "unstable" }> {
  const resolvedAuthDir = resolveUserPath(authDir);
  const result = await waitForWebAuthBarrier(resolvedAuthDir, "readWebAuthExistsForDecision");
  if (result === "timed_out") {
    return { outcome: "unstable" };
  }
  return {
    outcome: "stable",
    exists: await webAuthExists(resolvedAuthDir),
  };
}

export async function readWebAuthSnapshotBestEffort(authDir: string = resolveDefaultWebAuthDir()) {
  const resolvedAuthDir = resolveUserPath(authDir);
  const result = await waitForWebAuthBarrier(resolvedAuthDir, "readWebAuthSnapshotBestEffort");
  const linked = await webAuthExists(resolvedAuthDir);
  return {
    linked,
    timedOut: result === "timed_out",
    authAgeMs: linked ? getWebAuthAgeMs(resolvedAuthDir) : null,
    selfId: linked ? readWebSelfId(resolvedAuthDir) : emptyWebSelfId(),
  } as const;
}

async function clearLegacyBaileysAuthState(authDir: string) {
  const entries = await fs.readdir(authDir, { withFileTypes: true });
  const shouldDelete = (name: string) => {
    if (name === "oauth.json") {
      return false;
    }
    if (name === "creds.json" || name === "creds.json.bak") {
      return true;
    }
    if (!name.endsWith(".json")) {
      return false;
    }
    return /^(app-state-sync|session|sender-key|pre-key)-/.test(name);
  };
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }
      if (!shouldDelete(entry.name)) {
        return;
      }
      await fs.rm(path.join(authDir, entry.name), { force: true });
    }),
  );
}

async function shouldClearOnLogout(authDir: string, isLegacyAuthDir: boolean): Promise<boolean> {
  try {
    const stats = await fs.stat(authDir);
    if (!stats.isDirectory()) {
      return true;
    }
    if (isLegacyAuthDir) {
      const entries = await fs.readdir(authDir, { withFileTypes: true });
      return entries.some((entry) => {
        if (!entry.isFile()) {
          return false;
        }
        if (entry.name === "oauth.json") {
          return false;
        }
        if (entry.name === "creds.json" || entry.name === "creds.json.bak") {
          return true;
        }
        return entry.name.endsWith(".json")
          ? /^(app-state-sync|session|sender-key|pre-key)-/.test(entry.name)
          : false;
      });
    }
    const entries = await fs.readdir(authDir);
    return entries.length > 0;
  } catch (error) {
    const codeValue =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    const code = typeof codeValue === "string" ? codeValue : "";
    return code !== "ENOENT";
  }
}

export async function logoutWeb(params: {
  authDir?: string;
  isLegacyAuthDir?: boolean;
  runtime?: RuntimeEnv;
}) {
  const runtime = params.runtime ?? defaultRuntime;
  const resolvedAuthDir = resolveUserPath(params.authDir ?? resolveDefaultWebAuthDir());
  const barrierResult = await waitForWebAuthBarrier(resolvedAuthDir, "logoutWeb");
  if (barrierResult === "timed_out") {
    runtime.log(
      info("WhatsApp auth state is still stabilizing; clearing cached credentials anyway."),
    );
  }
  if (!(await shouldClearOnLogout(resolvedAuthDir, Boolean(params.isLegacyAuthDir)))) {
    runtime.log(info("No WhatsApp Web session found; nothing to delete."));
    return false;
  }
  if (params.isLegacyAuthDir) {
    try {
      await clearLegacyBaileysAuthState(resolvedAuthDir);
    } catch {
      // Explicit logout should still clear broken legacy auth dirs instead of no-oping on read failures.
      await fs.rm(resolvedAuthDir, { recursive: true, force: true });
    }
  } else {
    await fs.rm(resolvedAuthDir, { recursive: true, force: true });
  }
  runtime.log(success("Cleared WhatsApp Web credentials."));
  return true;
}

export function readWebSelfId(authDir: string = resolveDefaultWebAuthDir()) {
  // Read the cached WhatsApp Web identity (jid + E.164) from disk if present.
  try {
    const credsPath = resolveWebCredsPath(resolveUserPath(authDir));
    if (!fsSync.existsSync(credsPath)) {
      return emptyWebSelfId();
    }
    const raw = fsSync.readFileSync(credsPath, "utf-8");
    const parsed = JSON.parse(raw) as { me?: { id?: string; lid?: string } } | undefined;
    const identity = resolveComparableIdentity(
      {
        jid: parsed?.me?.id ?? null,
        lid: parsed?.me?.lid ?? null,
      },
      authDir,
    );
    return {
      e164: identity.e164 ?? null,
      jid: identity.jid ?? null,
      lid: identity.lid ?? null,
    } as const;
  } catch {
    return emptyWebSelfId();
  }
}

export async function readWebSelfIdentity(
  authDir: string = resolveDefaultWebAuthDir(),
  fallback?: { id?: string | null; lid?: string | null } | null,
): Promise<WhatsAppSelfIdentity> {
  const resolvedAuthDir = resolveUserPath(authDir);
  try {
    const raw = await fs.readFile(resolveWebCredsPath(resolvedAuthDir), "utf-8");
    const parsed = JSON.parse(raw) as { me?: { id?: string; lid?: string } } | undefined;
    return resolveComparableIdentity(
      {
        jid: parsed?.me?.id ?? null,
        lid: parsed?.me?.lid ?? null,
      },
      resolvedAuthDir,
    );
  } catch {
    return resolveComparableIdentity(
      {
        jid: fallback?.id ?? null,
        lid: fallback?.lid ?? null,
      },
      resolvedAuthDir,
    );
  }
}

export async function readWebSelfIdentityForDecision(
  authDir: string = resolveDefaultWebAuthDir(),
  fallback?: { id?: string | null; lid?: string | null } | null,
): Promise<{ outcome: "stable"; identity: WhatsAppSelfIdentity } | { outcome: "unstable" }> {
  const resolvedAuthDir = resolveUserPath(authDir);
  const result = await waitForWebAuthBarrier(resolvedAuthDir, "readWebSelfIdentityForDecision");
  if (result === "timed_out") {
    return { outcome: "unstable" };
  }
  return {
    outcome: "stable",
    identity: await readWebSelfIdentity(resolvedAuthDir, fallback),
  };
}

/**
 * Return the age (in milliseconds) of the cached WhatsApp web auth state, or null when missing.
 * Helpful for heartbeats/observability to spot stale credentials.
 */
export function getWebAuthAgeMs(authDir: string = resolveDefaultWebAuthDir()): number | null {
  try {
    const stats = fsSync.statSync(resolveWebCredsPath(resolveUserPath(authDir)));
    return Date.now() - stats.mtimeMs;
  } catch {
    return null;
  }
}

export function logWebSelfId(
  authDir: string = resolveDefaultWebAuthDir(),
  runtime: RuntimeEnv = defaultRuntime,
  includeChannelPrefix = false,
) {
  // Human-friendly log of the currently linked personal web session.
  const { e164, jid, lid } = readWebSelfId(authDir);
  const parts = [jid ? `jid ${jid}` : null, lid ? `lid ${lid}` : null].filter(
    (value): value is string => Boolean(value),
  );
  const details =
    e164 || parts.length > 0
      ? `${e164 ?? "unknown"}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`
      : "unknown";
  const prefix = includeChannelPrefix ? "Web Channel: " : "";
  runtime.log(info(`${prefix}${details}`));
}

export async function pickWebChannel(
  pref: WebChannel | "auto",
  authDir: string = resolveDefaultWebAuthDir(),
): Promise<WebChannel> {
  const choice: WebChannel = pref === "auto" ? "web" : pref;
  const auth = await readWebAuthExistsForDecision(authDir);
  if (auth.outcome === "unstable") {
    throw new WhatsAppAuthUnstableError();
  }
  if (!auth.exists) {
    throw new Error(
      `No WhatsApp Web session found. Run \`${formatCliCommand("openclaw channels login --channel whatsapp --verbose")}\` to link.`,
    );
  }
  return choice;
}
