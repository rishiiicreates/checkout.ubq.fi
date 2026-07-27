import { assert, assertEquals, assertRejects } from "@std/assert";
import { postPinnedWebhook } from "./webhook.ts";

Deno.test("webhook delivery dials a validated address while preserving the TLS hostname", async () => {
  const writes: Uint8Array[] = [];
  const response = new TextEncoder().encode(
    "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
  );
  let readOffset = 0;
  const dialed: unknown[][] = [];
  const result = await postPinnedWebhook(
    {
      url: new URL("https://merchant.example:8443/events?source=checkout"),
      addresses: ["93.184.216.34"],
    },
    '{"eventJws":"signed"}',
    AbortSignal.timeout(1_000),
    {
      dial: (hostname, port, signal) => {
        dialed.push([hostname, port, signal instanceof AbortSignal]);
        return Promise.resolve({
          remoteAddress: "93.184.216.34",
          connection: {
            read(buffer: Uint8Array): Promise<number | null> {
              if (readOffset === response.byteLength) return Promise.resolve(null);
              const count = Math.min(buffer.byteLength, response.byteLength - readOffset);
              buffer.set(response.subarray(readOffset, readOffset + count));
              readOffset += count;
              return Promise.resolve(count);
            },
            write(buffer: Uint8Array): Promise<number> {
              writes.push(buffer.slice());
              return Promise.resolve(buffer.byteLength);
            },
            close() {},
          },
        });
      },
    },
  );

  assertEquals(dialed, [["merchant.example", 8443, true]]);
  assertEquals(result, { status: 204, ok: true });
  const request = new TextDecoder().decode(concat(writes));
  assert(request.startsWith("POST /events?source=checkout HTTP/1.1\r\n"));
  assert(request.includes("\r\nHost: merchant.example:8443\r\n"));
  assert(request.endsWith('\r\n\r\n{"eventJws":"signed"}'));
});

Deno.test("webhook delivery rejects DNS rebinding before writing the payload", async () => {
  let writes = 0;
  let closed = 0;
  await assertRejects(
    () =>
      postPinnedWebhook(
        {
          url: new URL("https://merchant.example/hook"),
          addresses: ["198.51.100.1", "198.51.100.2"],
        },
        '{"eventJws":"must-not-leak"}',
        AbortSignal.timeout(1_000),
        {
          dial: () =>
            Promise.resolve({
              remoteAddress: "127.0.0.1",
              connection: {
                read: () => Promise.resolve(null),
                write: (buffer: Uint8Array) => {
                  writes += buffer.byteLength;
                  return Promise.resolve(buffer.byteLength);
                },
                close: () => {
                  closed++;
                },
              },
            }),
        },
      ),
    Error,
    "webhook_address_changed",
  );
  assertEquals(writes, 0);
  assertEquals(closed, 1);
});

Deno.test("webhook delivery accepts the address selected from the validated set", async () => {
  const response = new TextEncoder().encode(
    "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n",
  );
  let offset = 0;
  const result = await postPinnedWebhook(
    {
      url: new URL("https://merchant.example/hook"),
      addresses: ["198.51.100.1", "198.51.100.2"],
    },
    "{}",
    AbortSignal.timeout(1_000),
    {
      dial: () =>
        Promise.resolve({
          remoteAddress: "198.51.100.2",
          connection: {
            read(buffer: Uint8Array): Promise<number | null> {
              if (offset === response.byteLength) return Promise.resolve(null);
              const count = Math.min(buffer.byteLength, response.byteLength - offset);
              buffer.set(response.subarray(offset, offset + count));
              offset += count;
              return Promise.resolve(count);
            },
            write(buffer: Uint8Array): Promise<number> {
              return Promise.resolve(buffer.byteLength);
            },
            close() {},
          },
        }),
    },
  );

  assertEquals(result, { status: 503, ok: false });
});

function concat(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
