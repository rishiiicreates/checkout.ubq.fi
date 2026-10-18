export {};

// Preserve Wrangler's declarations and normalize only trailing spaces/tabs.
const generated = new URL("../worker-configuration.d.ts", import.meta.url);
const source = await Bun.file(generated).text();
const normalized = source.replace(/[ \t]+$/gm, "");
if (normalized !== source) await Bun.write(generated, normalized);
