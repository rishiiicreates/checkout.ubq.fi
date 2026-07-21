const API_BASE = "https://api.deno.com/v2";
const ENTRYPOINT = "main.ts";

interface Asset {
  kind: "file";
  encoding: "base64";
  content: string;
}

interface Revision {
  id: string;
  status: "skipped" | "queued" | "building" | "succeeded" | "failed";
  failure_reason: string | null;
}

interface DenoJson {
  deploy?: {
    app?: string;
    org?: string;
  };
}

const root = Deno.args[0] ?? ".deploy-root";
const token = readRequiredEnv("DENO_DEPLOY_TOKEN");
const denoJson = await readDenoJson(root);
const app = readRequiredConfig(denoJson.deploy?.app, "deploy.app");

if (!token.startsWith("ddo_")) {
  throw new Error(
    "DENO_DEPLOY_TOKEN must be a Deno Deploy organization API token starting with ddo_.",
  );
}

const deployConfig = {
  install: null,
  build: null,
  predeploy: null,
  runtime: {
    type: "dynamic",
    entrypoint: ENTRYPOINT,
  },
};

await ensureApp(app);
const assets = await collectAssets(root);
const revision = await api<Revision>(`/apps/${encodeURIComponent(app)}/deploy`, {
  method: "POST",
  body: {
    assets,
    config: deployConfig,
    production: true,
    labels: {
      "custom.git_sha": Deno.env.get("GITHUB_SHA") ?? "",
      "custom.github_run": Deno.env.get("GITHUB_RUN_ID") ?? "",
    },
  },
});

console.log(`Created Deno Deploy revision ${revision.id}`);
await waitForRevision(revision.id);

async function ensureApp(appSlug: string): Promise<void> {
  const existing = await fetch(`${API_BASE}/apps/${encodeURIComponent(appSlug)}`, {
    headers: authHeaders(),
  });

  if (existing.status === 404) {
    await api("/apps", {
      method: "POST",
      body: {
        slug: appSlug,
        config: deployConfig,
      },
    });
    console.log(`Created Deno Deploy app ${appSlug}`);
    return;
  }

  if (!existing.ok) {
    throw await responseError("GET", `/apps/${appSlug}`, existing);
  }

  await api(`/apps/${encodeURIComponent(appSlug)}`, {
    method: "PATCH",
    body: { config: deployConfig },
  });
  console.log(`Configured Deno Deploy app ${appSlug}`);
}

async function waitForRevision(id: string): Promise<void> {
  const started = Date.now();
  let lastStatus = "";

  while (Date.now() - started < 10 * 60 * 1000) {
    const revision = await api<Revision>(`/revisions/${encodeURIComponent(id)}`);
    if (revision.status !== lastStatus) {
      console.log(`Revision ${id}: ${revision.status}`);
      lastStatus = revision.status;
    }

    if (revision.status === "succeeded") {
      return;
    }

    if (revision.status === "failed" || revision.status === "skipped") {
      await printBuildLogs(id);
      throw new Error(`Revision ${id} ${revision.status}: ${revision.failure_reason ?? "unknown"}`);
    }

    await delay(5000);
  }

  await printBuildLogs(id);
  throw new Error(`Timed out waiting for Deno Deploy revision ${id}`);
}

async function printBuildLogs(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/revisions/${encodeURIComponent(id)}/build_logs`, {
    headers: {
      ...authHeaders(),
      accept: "application/x-ndjson",
    },
  });

  if (!response.ok) {
    console.error(`Could not read Deno build logs: ${response.status} ${await response.text()}`);
    return;
  }

  const text = await response.text();
  if (!text.trim()) {
    console.error("Deno build logs were empty.");
    return;
  }

  console.error("Deno build logs:");
  for (const line of text.trim().split("\n")) {
    try {
      const entry = JSON.parse(line) as { step?: string; level?: string; message?: string };
      console.error(
        `[${entry.step ?? "build"}] ${entry.level ?? "info"}: ${entry.message ?? line}`,
      );
    } catch {
      console.error(line);
    }
  }
}

async function collectAssets(rootPath: string): Promise<Record<string, Asset>> {
  const assets: Record<string, Asset> = {};
  const rootUrl = await Deno.realPath(rootPath);

  async function walk(directory: string): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(path);
        continue;
      }
      if (!entry.isFile) {
        continue;
      }

      const relativePath = path.slice(rootUrl.length + 1);
      const bytes = await Deno.readFile(path);
      assets[relativePath] = {
        kind: "file",
        encoding: "base64",
        content: encodeBase64(bytes),
      };
    }
  }

  await walk(rootUrl);
  return assets;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (!response.ok) {
    throw await responseError(method, path, response);
  }

  return await response.json() as T;
}

async function responseError(method: string, path: string, response: Response): Promise<Error> {
  const text = await response.text();
  return new Error(`${method} ${path} failed with HTTP ${response.status}: ${text}`);
}

async function readDenoJson(rootPath: string): Promise<DenoJson> {
  return JSON.parse(await Deno.readTextFile(`${rootPath}/deno.json`)) as DenoJson;
}

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
  };
}

function readRequiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

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
