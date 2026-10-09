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
): Promise<{ htmlUrl: string }> {
  const filePath = `exports/${filename}`;
  const encodedPath = encodeURIComponent(filePath);

  // Check for existing file to get its SHA (required for updates)
  const checkRes = await githubFetch(
    `/repos/${fullName}/contents/${encodedPath}`,
  );

  let existingSha: string | undefined;

  if (checkRes.ok) {
    const existing = await checkRes.json() as { sha?: string };
    existingSha = existing.sha;
  } else if (checkRes.status !== 404) {
    throw new Error(`Failed to check existing file: ${checkRes.status}`);
  }

  // Encode content to base64 if not already encoded
  let base64Content = content;

  if (!alreadyBase64) {
    const bytes = new TextEncoder().encode(content);
    const CHUNK = 8192;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    base64Content = btoa(binary);
  }

  const commitMessage = existingSha
    ? `Update ${filename} via ChatScribe`
    : `Add ${filename} via ChatScribe`;

  const putRes = await githubFetch(
    `/repos/${fullName}/contents/${encodedPath}`,
    {
      method: "PUT",
      body: JSON.stringify({
        message: commitMessage,
        content: base64Content,
        sha: existingSha,
      }),
    },
  );

  // Handle 409 Conflict (SHA changed between GET and PUT — race condition)
  if (putRes.status === 409) {
    const retryCheck = await githubFetch(
      `/repos/${fullName}/contents/${encodedPath}`,
    );
    const retrySha = retryCheck.ok
      ? ((await retryCheck.json()) as { sha?: string }).sha
      : undefined;

    const retryPut = await githubFetch(
      `/repos/${fullName}/contents/${encodedPath}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: `Update ${filename} via ChatScribe`,
          content: base64Content,
          sha: retrySha,
        }),
      },
    );

    if (!retryPut.ok) {
      throw new Error(
        "Conflict saving the file (another write happened simultaneously). Please try again.",
      );
    }

    const retryData = await retryPut.json() as {
      content?: { html_url?: string };
    };
    return { htmlUrl: retryData.content?.html_url ?? `https://github.com/${fullName}` };
  }

  if (!putRes.ok) {
    const body = await putRes.json().catch(() => null) as { message?: string } | null;
    throw new Error(
      body?.message ?? `Failed to save file: ${putRes.status}`,
    );
  }

  const putData = await putRes.json() as {
    content?: { html_url?: string };
  };

  return {
    htmlUrl: putData.content?.html_url ?? `https://github.com/${fullName}`,
  };
}

// -----------------------------------------------------------------------
// DISCONNECT
// -----------------------------------------------------------------------

export async function disconnectGitHub(): Promise<void> {
  await clearToken();
}
