/** Browser/cookie adapter for shared Cloud repository authorization. */
import type { Context } from "hono";
import { getCookie, deleteCookie } from "hono/cookie";
import { repos } from "@repo/db";
import { AppError } from "@repo/core";
import { auth } from "@repo/platform/engine/lib/auth";
import {
  resolveAuthBaseUrl,
  resolveDashboardPublicUrl,
} from "@repo/platform/engine/lib/public-url";
import {
  beginRepositoryAuthorization,
  completeRepositoryAuthorization,
  repositoryOAuthCookieName,
  repositoryOAuthStateCookie,
  REPOSITORY_OAUTH_CALLBACK_PATH,
} from "@repo/platform/engine/modules/github/github-repository-authorization";

function failed(c: Context, error: unknown) {
  const detail =
    error instanceof AppError
      ? error.message
      : "GitHub connection failed. Please try again or use a personal token.";
  const state = c.req.query("state") ?? c.req.query("install_state");
  return c.redirect(
    `${resolveDashboardPublicUrl()}/auth/callback/close?${new URLSearchParams({ error: detail, ...(state ? { state } : {}) })}`,
  );
}

export async function startRepositoryAuthorization(c: Context) {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  try {
    const state = c.req.query("install_state") ?? "";
    const [session, binding] = await Promise.all([
      auth.api.getSession({ headers: c.req.raw.headers, query: { disableCookieCache: true } }),
      repos.githubInstallState.find(state),
    ]);
    if (!session || !binding?.organizationId || binding.userId !== session.user.id)
      throw new AppError(
        "Your GitHub connection attempt or session expired. Sign in and try again.",
        401,
        "GITHUB_ATTEMPT_EXPIRED",
      );
    const result = await beginRepositoryAuthorization(
      {
        userId: session.user.id,
        organizationId: binding.organizationId,
        sessionId: session.session.id,
      },
      state,
    );
    c.header("Set-Cookie", repositoryOAuthStateCookie(result.state, result.browserNonce));
    return c.redirect(result.url);
  } catch (error) {
    return failed(c, error);
  }
}

export async function finishRepositoryAuthorization(c: Context) {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const state = c.req.query("state") ?? "";
  const cookieName = repositoryOAuthCookieName(state);
  try {
    const result = await completeRepositoryAuthorization({
      state,
      code: c.req.query("code"),
      error: c.req.query("error"),
      browserNonce: getCookie(c, cookieName),
    });
    deleteCookie(c, cookieName, { path: REPOSITORY_OAUTH_CALLBACK_PATH });
    if (result.callbackMode === "bridge")
      return c.redirect(`${resolveAuthBaseUrl()}/api/cloud/github/oauth-success`);
    return c.redirect(
      `${resolveDashboardPublicUrl()}/auth/callback/install?${new URLSearchParams({ state: result.state })}`,
    );
  } catch (error) {
    deleteCookie(c, cookieName, { path: REPOSITORY_OAUTH_CALLBACK_PATH });
    return failed(c, error);
  }
}
