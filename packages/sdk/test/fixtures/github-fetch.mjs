// Test-only GitHub boundary for the real native worker. Keep platform operations,
// encryption, authorization and persistence unchanged, without contacting GitHub.
const networkFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== "https://api.github.com") return networkFetch(input, init);
  if (request.method !== "GET" || url.pathname !== "/user") {
    throw new Error(`Unexpected GitHub fixture request: ${request.method} ${url.pathname}`);
  }
  if (request.headers.get("authorization") !== "Bearer persistent-private-token") {
    return Response.json({ message: "Bad credentials" }, { status: 401 });
  }
  return Response.json(
    { login: "alice", id: 1, avatar_url: "" },
    { headers: { "x-oauth-scopes": "repo" } },
  );
};
