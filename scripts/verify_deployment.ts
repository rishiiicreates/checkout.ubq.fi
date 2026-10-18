export {};
const origin = "https://checkout.ubq.fi";
const paths = ["/api/health", "/.well-known/jwks.json", "/", "/styles.css", "/app.js"];
let version: string | null = null;
for (const path of paths) {
  const response = await fetch(new URL(path, origin), {
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  });
  if (response.headers.get("x-uos-runtime") !== "cloudflare-workers")
    throw new Error("deployment_runtime_mismatch");
  const servedVersion = response.headers.get("x-uos-version");
  if (!servedVersion || (version && servedVersion !== version))
    throw new Error("deployment_version_mismatch");
  version = servedVersion;
  if (response.status !== 200)
    throw new Error(`deployment_verification_failed:${path}:${response.status}`);
  if (path === "/api/health" && (await response.json()).status !== "ready")
    throw new Error("deployment_not_ready");
  if (path === "/.well-known/jwks.json" && !Array.isArray((await response.json()).keys))
    throw new Error("deployment_jwks_missing");
  if (!response.bodyUsed) await response.body?.cancel();
  console.log(`Verified ${path}`);
}
const session = await fetch(`${origin}/api/v1/admin/session`, {
  signal: AbortSignal.timeout(15_000),
});
if ((await session.json()).authenticated !== false)
  throw new Error("unexpected_public_admin_session");
console.log("Verified public requests cannot become local administrators");

console.log(`Verified Worker version ${version}`);
