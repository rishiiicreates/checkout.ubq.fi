import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server, type TLSSocket } from "node:tls";
import { postBunWebhook } from "./bun_webhook.ts";

const CASES = ["trusted-host", "wrong-host", "changed-peer"] as const;
type CaseName = (typeof CASES)[number];
const CHILD_FLAG = "--uos-tls-fixture-child";
const CHILD_ENV_PATH = process.env.PATH ?? "/usr/bin:/bin";
const BODY = JSON.stringify({ eventJws: "uos-offline-tls-fixture-π" });
const CHILD_ENV_KEYS = ["NODE_EXTRA_CA_CERTS", "PATH"];

type FixtureObservation = {
  chunks: Uint8Array[];
  sni: Array<string | false | null>;
  alpn: Array<string | false | null>;
  connections: number;
  secureConnections: number;
  closedConnections: number;
  closePromises: Promise<void>[];
  sockets: Set<Socket>;
};

const childIndex = process.argv.indexOf(CHILD_FLAG);
if (childIndex !== -1) {
  const caseName = process.argv[childIndex + 1];
  const fixtureRoot = process.argv[childIndex + 2];
  try {
    assert(CASES.includes(caseName as CaseName), "unknown TLS fixture case");
    assert(fixtureRoot && basename(fixtureRoot).startsWith("uos-checkout-tls-"));
    await runChildCase(caseName as CaseName, fixtureRoot);
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
} else {
  const { test, beforeAll, afterAll } = await import("bun:test");
  let fixtureRoot: string | undefined;

  beforeAll(async () => {
    assertNoProductionEnvironment();
    fixtureRoot = await mkdtemp(join(tmpdir(), "uos-checkout-tls-"));
    await generateCertificates(fixtureRoot);
  }, 30_000);

  afterAll(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  });

  for (const caseName of CASES) {
    test(
      "real Bun TLS: " + caseName,
      async () => {
        assert(fixtureRoot);
        const result = await runProcess(
          [process.execPath, "--no-env-file", import.meta.path, CHILD_FLAG, caseName, fixtureRoot],
          {
            PATH: CHILD_ENV_PATH,
            NODE_EXTRA_CA_CERTS: join(fixtureRoot, "ca.pem"),
          },
        );
        assert.equal(result.code, 0, result.stderr || result.stdout);
        const report = JSON.parse(result.stdout.trim()) as {
          caseName: string;
          environmentKeys: string[];
          bytes: number;
        };
        assert.equal(report.caseName, caseName);
        assert.deepEqual(report.environmentKeys, CHILD_ENV_KEYS);
        console.log(JSON.stringify(report));
      },
      20_000,
    );
  }
}

function assertNoProductionEnvironment(): void {
  const names = Object.keys(process.env).filter((name) =>
    /^(?:CHECKOUT_|AUTH_|DENO_|CLOUDFLARE_|CF_|OPENAI_|ANTHROPIC_|AWS_|GITHUB_TOKEN$|GH_TOKEN$)/u.test(
      name,
    ),
  );
  assert.deepEqual(names, [], "fixture must inherit no production credentials");
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
}

async function generateCertificates(root: string): Promise<void> {
  await openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-noenc",
    "-sha256",
    "-days",
    "1",
    "-subj",
    "/CN=uos-checkout-offline-test-ca",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout",
    join(root, "ca.key"),
    "-out",
    join(root, "ca.pem"),
  ]);
  await openssl([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-noenc",
    "-sha256",
    "-subj",
    "/CN=localhost",
    "-keyout",
    join(root, "server.key"),
    "-out",
    join(root, "server.csr"),
  ]);
  for (const [name, hostname, serial] of [
    ["trusted", "localhost", "1001"],
    ["wrong", "wrong-host.invalid", "1002"],
  ]) {
    const extensions = [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=DNS:" + hostname,
      "",
    ].join("\n");
    await writeFile(join(root, name + ".ext"), extensions);
    await openssl([
      "x509",
      "-req",
      "-sha256",
      "-days",
      "1",
      "-in",
      join(root, "server.csr"),
      "-CA",
      join(root, "ca.pem"),
      "-CAkey",
      join(root, "ca.key"),
      "-set_serial",
      serial,
      "-extfile",
      join(root, name + ".ext"),
      "-out",
      join(root, name + ".pem"),
    ]);
  }
}

async function openssl(args: string[]): Promise<void> {
  const binary = Bun.which("openssl");
  assert(binary, "OpenSSL is required for the isolated TLS certificate fixture");
  const result = await runProcess([binary, ...args], { PATH: CHILD_ENV_PATH });
  assert.equal(result.code, 0, result.stderr);
}

async function runProcess(cmd: string[], env: Record<string, string>) {
  const processHandle = Bun.spawn({
    cmd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => processHandle.kill("SIGKILL"), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(deadline);
    if (processHandle.exitCode === null) {
      processHandle.kill("SIGKILL");
      await processHandle.exited;
    }
  }
}

async function runChildCase(caseName: CaseName, root: string): Promise<void> {
  assertNoProductionEnvironment();
  assert.deepEqual(Object.keys(process.env).sort(), CHILD_ENV_KEYS);
  assert.equal(process.env.NODE_EXTRA_CA_CERTS, join(root, "ca.pem"));
  const observation: FixtureObservation = {
    chunks: [],
    sni: [],
    alpn: [],
    connections: 0,
    secureConnections: 0,
    closedConnections: 0,
    closePromises: [],
    sockets: new Set(),
  };
  const key = await readFile(join(root, "server.key"));
  const cert = await readFile(join(root, caseName === "wrong-host" ? "wrong.pem" : "trusted.pem"));
  const servers: Server[] = [];
  let expectedRequest = "";
  const createFixtureServer = () => {
    const server = createServer({ key, cert, ALPNProtocols: ["http/1.1"] });
    server.on("connection", (socket: Socket) => {
      observation.connections++;
      observation.sockets.add(socket);
      observation.closePromises.push(
        new Promise<void>((resolve) => {
          socket.once("close", () => {
            observation.closedConnections++;
            observation.sockets.delete(socket);
            resolve();
          });
        }),
      );
      socket.on("error", () => {});
    });
    server.on("tlsClientError", (_error, socket) => socket.destroy());
    server.on("secureConnection", (socket: TLSSocket) => {
      observation.secureConnections++;
      observation.sni.push(
        "servername" in socket && typeof socket.servername === "string" ? socket.servername : null,
      );
      observation.alpn.push(socket.alpnProtocol ?? null);
      observation.sockets.add(socket);
      socket.once("close", () => observation.sockets.delete(socket));
      socket.on("error", () => {});
      let receivedBytes = 0;
      socket.on("data", (data: Buffer) => {
        const bytes = new Uint8Array(data);
        observation.chunks.push(bytes.slice());
        receivedBytes += bytes.byteLength;
        if (receivedBytes >= Buffer.byteLength(expectedRequest)) {
          socket.end("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
      });
    });
    return server;
  };

  try {
    const ipv4 = createFixtureServer();
    servers.push(ipv4);
    await listen(ipv4, "127.0.0.1", 0);
    const address = ipv4.address();
    assert(address && typeof address !== "string");
    const port = address.port;
    const ipv6 = createFixtureServer();
    servers.push(ipv6);
    try {
      await listen(ipv6, "::1", port);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EADDRNOTAVAIL", "EAFNOSUPPORT", "ENODEV"].includes(code ?? "")) throw error;
    }
    expectedRequest = [
      "POST /events?source=offline HTTP/1.1",
      "Host: localhost:" + port,
      "Accept: application/json",
      "Content-Type: application/json",
      "User-Agent: Ubiquity-Checkout/1.0",
      "Content-Length: " + Buffer.byteLength(BODY),
      "Connection: close",
      "",
      BODY,
    ].join("\r\n");
    const target = {
      url: new URL("https://localhost:" + port + "/events?source=offline"),
      addresses:
        caseName === "changed-peer" ? ["93.184.216.34"] : ["127.0.0.1", "::1", "::ffff:127.0.0.1"],
    };
    let result: Awaited<ReturnType<typeof postBunWebhook>> | undefined;
    let failure: unknown;
    try {
      result = await postBunWebhook(target, BODY, AbortSignal.timeout(5_000));
    } catch (error) {
      failure = error;
    }
    assert(observation.connections > 0, "fixture must accept an actual TCP connection");
    await within(Promise.all(observation.closePromises), 5_000);
    const applicationBytes = Buffer.concat(observation.chunks);
    if (caseName === "trusted-host") {
      assert.equal(failure, undefined);
      assert.deepEqual(result, { status: 204, ok: true });
      assert.deepEqual(applicationBytes, Buffer.from(expectedRequest));
      assert.deepEqual(observation.sni, ["localhost"]);
      assert.deepEqual(observation.alpn, ["http/1.1"]);
    } else {
      assert(failure instanceof Error, "rejection must be observed");
      assert.equal(applicationBytes.byteLength, 0, "no decrypted HTTP/body bytes before approval");
      if (caseName === "wrong-host") {
        const code = (failure as NodeJS.ErrnoException).code ?? "";
        assert.match(code + " " + failure.message, /ALTNAME|hostname|certificate.*match/iu);
      } else {
        assert.match(failure.message, /webhook_address_changed/u);
        assert.equal(observation.secureConnections, 1);
        assert.deepEqual(observation.sni, ["localhost"]);
      }
    }
    assert.equal(observation.closedConnections, observation.connections);
    console.log(
      JSON.stringify({
        caseName,
        bytes: applicationBytes.byteLength,
        connections: observation.connections,
        secureConnections: observation.secureConnections,
        closedConnections: observation.closedConnections,
        sni: observation.sni,
        alpn: observation.alpn,
        failureCode:
          failure instanceof Error
            ? ((failure as NodeJS.ErrnoException).code ?? failure.message)
            : null,
        environmentKeys: Object.keys(process.env).sort(),
      }),
    );
  } finally {
    for (const socket of observation.sockets) socket.destroy();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            if (!server.listening) return resolve();
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, ipv6Only: host === "::1" }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("fixture_socket_close_timeout")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
