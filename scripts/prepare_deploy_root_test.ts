import { prepareDeployRoot } from "./prepare_deploy_root.ts";

Deno.test("prepareDeployRoot copies auth app source and deploy scripts", async () => {
  const root = await Deno.makeTempDir({ prefix: "app-deploy-root-test-" });
  try {
    await Deno.writeTextFile(`${root}/main.ts`, "import './src/auth.ts';\n");
    await Deno.writeTextFile(`${root}/deno.json`, JSON.stringify({ deploy: { app: "x" } }));
    await Deno.writeTextFile(`${root}/README.md`, "# Sample\n");
    await Deno.mkdir(`${root}/public`);
    await Deno.writeTextFile(`${root}/public/index.html`, "<!doctype html>\n");
    await Deno.mkdir(`${root}/src`);
    await Deno.writeTextFile(`${root}/src/auth.ts`, "export {};\n");
    await Deno.mkdir(`${root}/scripts`);
    await Deno.writeTextFile(`${root}/scripts/deploy_deno_api.ts`, "export {};\n");

    const deployRoot = await prepareDeployRoot({ repoRoot: root, requestedRoot: ".deploy-root" });
    await assertFile(`${deployRoot}/main.ts`);
    await assertFile(`${deployRoot}/src/auth.ts`);
    await assertFile(`${deployRoot}/public/index.html`);
    await assertFile(`${deployRoot}/scripts/deploy_deno_api.ts`);
    await assertFile(`${deployRoot}/deploy-metadata.json`);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

async function assertFile(path: string): Promise<void> {
  const info = await Deno.stat(path);
  if (!info.isFile) throw new Error(`Expected file: ${path}`);
}
