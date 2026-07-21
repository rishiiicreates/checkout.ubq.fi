interface PrepareOptions {
  requestedRoot?: string;
  repoRoot?: string;
}

if (import.meta.main) {
  try {
    const root = await prepareDeployRoot({ requestedRoot: Deno.args[0] ?? ".deploy-root" });
    console.log(`Prepared deploy root: ${root}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(2);
  }
}

export async function prepareDeployRoot(options: PrepareOptions = {}): Promise<string> {
  const repoRoot = normalizePath(options.repoRoot ?? Deno.cwd());
  const requestedRoot = options.requestedRoot ?? ".deploy-root";
  const root = requestedRoot.startsWith("/")
    ? normalizePath(requestedRoot)
    : normalizePath(joinPath(repoRoot, requestedRoot));

  validateRoot(root, repoRoot);
  await Deno.remove(root, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  await Deno.mkdir(root, { recursive: true });

  await copyFileIfExists(joinPath(repoRoot, "main.ts"), joinPath(root, "main.ts"), true);
  await copyFileIfExists(joinPath(repoRoot, "deno.json"), joinPath(root, "deno.json"), true);
  await copyFileIfExists(joinPath(repoRoot, "README.md"), joinPath(root, "README.md"), true);
  await copyFileIfExists(joinPath(repoRoot, "deno.lock"), joinPath(root, "deno.lock"), false);
  await copyDirectory(joinPath(repoRoot, "public"), joinPath(root, "public"));
  await copyDirectory(joinPath(repoRoot, "src"), joinPath(root, "src"));

  await Deno.writeTextFile(
    joinPath(root, "deploy-metadata.json"),
    `${
      JSON.stringify({
        sha: readOptionalEnv("GITHUB_SHA") ?? "local",
        run: readOptionalEnv("GITHUB_RUN_ID") ?? "local",
      })
    }\n`,
  );

  return root;
}

function validateRoot(root: string, repoRoot: string): void {
  const home = Deno.env.get("HOME") ? normalizePath(Deno.env.get("HOME") ?? "") : "";
  const tmpRoot = normalizePath(Deno.env.get("TMPDIR") ?? "/tmp");
  const rootName = basename(root);

  if (!rootName.includes("deploy")) {
    throw new Error(`Deploy root must be a dedicated deploy-named directory: ${root}`);
  }
  if (root === "/" || root === "." || root === repoRoot || (home && root === home)) {
    throw new Error(`Refusing dangerous deploy root: ${root}`);
  }
  if (!isWithin(root, repoRoot) && !isWithin(root, tmpRoot)) {
    throw new Error(`Deploy root must live under the repository or temp directory: ${root}`);
  }
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await Deno.mkdir(target, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const sourcePath = joinPath(source, entry.name);
    const targetPath = joinPath(target, entry.name);
    if (entry.isDirectory) {
      await copyDirectory(sourcePath, targetPath);
    } else if (entry.isFile) {
      await Deno.copyFile(sourcePath, targetPath);
    }
  }
}

async function copyFileIfExists(source: string, target: string, required: boolean): Promise<void> {
  try {
    await Deno.copyFile(source, target);
  } catch (error) {
    if (!required && error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}

function isWithin(path: string, parent: string): boolean {
  return path.startsWith(`${parent.replace(/\/+$/g, "")}/`);
}

function readOptionalEnv(name: string): string | null {
  try {
    return Deno.env.get(name) ?? null;
  } catch {
    return null;
  }
}

function basename(path: string): string {
  const parts = normalizePath(path).split("/").filter(Boolean);
  return parts.at(-1) ?? "";
}

function joinPath(...parts: string[]): string {
  return normalizePath(parts.join("/"));
}

function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}` || ".";
}
