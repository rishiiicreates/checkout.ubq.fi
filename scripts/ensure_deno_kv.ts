interface DenoJson {
  deploy?: {
    org?: string;
    app?: string;
  };
}

const API_BASE = "https://api.deno.com/v2";
const deployConfig = {
  install: null,
  build: null,
  predeploy: null,
  runtime: {
    type: "dynamic",
    entrypoint: "main.ts",
  },
};

const token = Deno.env.get("DENO_DEPLOY_TOKEN")?.trim();
if (!token) throw new Error("DENO_DEPLOY_TOKEN is required");
if (!token.startsWith("ddo_")) {
  throw new Error(
    "DENO_DEPLOY_TOKEN must be a Deno Deploy organization API token starting with ddo_.",
  );
}

const denoJson = JSON.parse(await Deno.readTextFile("deno.json")) as DenoJson;
const org = required(denoJson.deploy?.org, "deploy.org");
const app = required(denoJson.deploy?.app, "deploy.app");
const desiredDatabase = `${app}-kv`;

await ensureApp(app);

let database = desiredDatabase;
const provision = await runDenoDeploy([
  "database",
  "provision",
  desiredDatabase,
  "--kind",
  "denokv",
  "--token",
  token,
  "--org",
  org,
]);

if (!provision.success) {
  const output = `${provision.stdout}\n${provision.stderr}`;
  if (/already|exist/i.test(output)) {
    database = desiredDatabase;
  } else {
    throw new Error(
      `Could not provision the dedicated ${desiredDatabase} database. ` +
        `Checkout must never share another application's KV database:\n${output}`,
    );
  }
}

const assign = await runDenoDeploy([
  "database",
  "assign",
  database,
  "--token",
  token,
  "--org",
  org,
  "--app",
  app,
]);

if (!assign.success && !/already|assigned|exist/i.test(`${assign.stdout}\n${assign.stderr}`)) {
  throw new Error(`Could not assign Deno KV database:\n${assign.stdout}\n${assign.stderr}`);
}

console.log(`Deno KV database assigned: ${database}`);

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

async function runDenoDeploy(args: string[]) {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["deploy", ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    success: output.success,
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
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

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
  };
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes("{{") || trimmed.includes("}}")) {
    throw new Error(`${name} is required in deno.json`);
  }
  return trimmed;
}
