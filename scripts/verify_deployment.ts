interface DenoJson {
  deploy?: {
    app?: string;
    org?: string;
  };
}

const denoJson = JSON.parse(await Deno.readTextFile("deno.json")) as DenoJson;
const app = readRequiredConfig(denoJson.deploy?.app, "deploy.app");
const org = readRequiredConfig(denoJson.deploy?.org, "deploy.org");
const baseUrl = `https://${app}.${org}.deno.net`;

for (let attempt = 1; attempt <= 60; attempt += 1) {
  const response = await fetch(`${baseUrl}/api/health`).catch(() => null);
  if (response?.ok) {
    const body = await response.json().catch(() => null) as { status?: unknown } | null;
    if (body?.status === "ready") {
      console.log(`${baseUrl}/api/health returned ready`);
      Deno.exit(0);
    }
  }
  await delay(5000);
}

console.error(`${baseUrl}/api/health did not return ready before timeout`);
Deno.exit(1);

function readRequiredConfig(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes("{{") || trimmed.includes("}}")) {
    throw new Error(`${name} is required in deno.json`);
  }
  return trimmed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
