/**
 * github.ts — ChatScribe
 *
 * GitHub Device Flow OAuth and repository operations.
 *
 * All network calls happen through this module; background.ts delegates
 * to these functions so the auth poll survives popup closure.
 *
 * Device flow steps:
 *   1. POST /login/device/code  → get user_code + device_code
 *   2. Show user_code to user; they visit github.com/login/device
 *   3. Poll POST /login/oauth/access_token until "authorized"
 *   4. Store the access_token in chrome.storage.local
 */

import { t } from "./i18n.ts";
import {
  assertGitHubPayloadSize,
  base64LengthForText,
} from "./export-limits.ts";

// Public client ID for ChatScribe's GitHub OAuth App (Device Flow enabled).
const GITHUB_CLIENT_ID = "Ov23livM5zFifnOcvad6";
const TOKEN_KEY = "githubAccessToken";

// -----------------------------------------------------------------------
// TOKEN STORAGE
// -----------------------------------------------------------------------

export async function getStoredToken(): Promise<string | null> {
  const stored = await chrome.storage.local.get({ [TOKEN_KEY]: null });
  const val = stored[TOKEN_KEY];
  return typeof val === "string" && val.length > 0 ? val : null;
}

async function storeToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
}

export async function clearToken(): Promise<void> {
  await chrome.storage.local.remove(TOKEN_KEY);
}

// -----------------------------------------------------------------------
// AUTHENTICATED API REQUEST
// -----------------------------------------------------------------------

async function githubFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getStoredToken();
  if (!token) throw new Error(t("github.error.notConnected"));

  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (response.status === 401) {
    // Token revoked — clear it so UI can prompt reconnect
    await clearToken();
    throw new Error(t("github.error.expired"));
  }

  return response;
}

// -----------------------------------------------------------------------
// DEVICE FLOW: START
// -----------------------------------------------------------------------

export interface DeviceCodeResult {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export async function startDeviceFlow(): Promise<DeviceCodeResult> {
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: "repo",
    }),
  });

  if (!response.ok) {
    throw new Error(t("github.error.unknown"));
  }

  const data = await response.json() as DeviceCodeResult & { error?: string };

  if (data.error) {
    throw new Error(t("github.error.unknown"));
  }

  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error(t("github.error.unknown"));
  }

  return data;
}

// -----------------------------------------------------------------------
// DEVICE FLOW: POLL
// -----------------------------------------------------------------------

export async function pollForToken(
  deviceCode: string,
  intervalSecs: number,
  expiresInSecs: number,
): Promise<void> {
  const deadline = Date.now() + expiresInSecs * 1000;
  let pollInterval = Math.max(5, intervalSecs) * 1000;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!response.ok) continue;

    const data = await response.json() as {
      access_token?: string;
      error?: string;
      interval?: number;
    };

    if (data.access_token) {
      await storeToken(data.access_token);
      return;
    }

    switch (data.error) {
      case "authorization_pending":
        // Normal — user hasn't authorized yet
        break;
      case "slow_down":
        // Back off
        if (typeof data.interval === "number") {
          pollInterval = Math.max(pollInterval, data.interval * 1000 + 1000);
        } else {
          pollInterval += 5000;
        }
        break;
      case "expired_token":
        throw new Error(t("github.error.codeExpired"));
      case "access_denied":
        throw new Error(t("github.error.cancelled"));
      default:
        throw new Error(t("github.error.unknown"));
    }
  }

  throw new Error(t("github.error.codeExpired"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// -----------------------------------------------------------------------
// CURRENT USER
// -----------------------------------------------------------------------

export interface GitHubUser {
  login: string;
  id: number;
}

export async function getCurrentUser(): Promise<GitHubUser> {
  const response = await githubFetch("/user");

  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub user: ${response.status}`);
  }

  return response.json() as Promise<GitHubUser>;
}

// -----------------------------------------------------------------------
// LIST REPOS
// -----------------------------------------------------------------------

export interface GitHubRepo {
  full_name: string;
  private: boolean;
  permissions?: {
    push: boolean;
    pull: boolean;
    admin: boolean;
  };
}

export async function listUserRepos(): Promise<GitHubRepo[]> {
  const response = await githubFetch(
    "/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator",
  );

  if (!response.ok) {
    throw new Error(`Failed to list repositories: ${response.status}`);
  }

  const repos = await response.json() as GitHubRepo[];

  // Only repos the user can push to
  return repos.filter((r) => r.permissions?.push !== false);
}

// -----------------------------------------------------------------------
// SAVE FILE TO REPO
// -----------------------------------------------------------------------

export async function saveFileToRepo(
  fullName: string,
  filename: string,
  content: string,
  alreadyBase64 = false,
): Promise<{ htmlUrl: string; path: string; filename: string }> {
  let base64Content = content;
  if (!alreadyBase64) {
    assertGitHubPayloadSize(base64LengthForText(content));
    const bytes = new TextEncoder().encode(content);
    const CHUNK = 8192;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    base64Content = btoa(binary);
  }
  assertGitHubPayloadSize(base64Content.length);

  const filenameForAttempt = (attempt: number): string => {
    if (attempt === 1) return filename;
    const extensionIndex = filename.lastIndexOf(".");
    const hasExtension = extensionIndex > 0;
    const stem = hasExtension ? filename.slice(0, extensionIndex) : filename;
    const extension = hasExtension ? filename.slice(extensionIndex) : "";
    return `${stem}-${attempt}${extension}`;
  };

  for (let attempt = 1; attempt <= 100; attempt++) {
    const actualFilename = filenameForAttempt(attempt);
    const filePath = `exports/${actualFilename}`;
    const encodedPath = encodeURIComponent(filePath);
    const checkRes = await githubFetch(`/repos/${fullName}/contents/${encodedPath}`);

    if (checkRes.ok) continue;
    if (checkRes.status !== 404) {
      throw new Error(`Failed to check existing file: ${checkRes.status}`);
    }

    // Create-only request: never send a SHA, so this operation cannot update
    // an existing conversation export.
    const putRes = await githubFetch(
      `/repos/${fullName}/contents/${encodedPath}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: `Add ${actualFilename} via ChatScribe`,
          content: base64Content,
        }),
      },
    );

    if (putRes.ok) {
      const putData = await putRes.json() as {
        content?: { html_url?: string; path?: string };
      };
      return {
        htmlUrl: putData.content?.html_url ?? `https://github.com/${fullName}`,
        path: putData.content?.path ?? filePath,
        filename: actualFilename,
      };
    }

    if (putRes.status === 409 || putRes.status === 422) {
      const collisionCheck = await githubFetch(`/repos/${fullName}/contents/${encodedPath}`);
      if (collisionCheck.ok) continue;
      if (collisionCheck.status === 404) {
        const body = await putRes.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message ?? `Failed to create file: ${putRes.status}`);
      }
      throw new Error(`Failed to verify a filename collision: ${collisionCheck.status}`);
    }

    const body = await putRes.json().catch(() => null) as { message?: string } | null;
    throw new Error(body?.message ?? `Failed to save file: ${putRes.status}`);
  }

  throw new Error("Could not find an unused GitHub filename after 100 attempts.");
}

// -----------------------------------------------------------------------
// DISCONNECT
// -----------------------------------------------------------------------

export async function disconnectGitHub(): Promise<void> {
  await clearToken();
}
