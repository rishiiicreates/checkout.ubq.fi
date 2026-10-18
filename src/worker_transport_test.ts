import { test } from "bun:test";
import { deepStrictEqual as equal, ok, rejects } from "node:assert/strict";
import { createWorkerTransport } from "./worker_transport.ts";
import { WorkerBudgetError, WorkerRequestBudget } from "./worker_budget.ts";
import { createMerchantAuthService } from "./merchant_auth.ts";
import { SqliteKv } from "./sqlite_kv.ts";
import type { FetchLike } from "./rpc.ts";

const target = {
  url: new URL("https://merchant.example:8443/events?invoice=a"),
  addresses: ["93.184.216.34"],
};

test("Worker webhook uses original HTTPS URL, fresh headers, no redirects and bounded response", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let cancelled = false;
  const transport = createWorkerTransport(async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 202 },
    );
  });
  equal(
    await transport.webhookSender(target, '{"eventJws":"offline"}', AbortSignal.timeout(1000)),
    { status: 202, ok: true },
  );
  equal(calls.length, 1);
  equal(calls[0].url, target.url.toString());
  equal(calls[0].init?.redirect, "manual");
  equal(calls[0].init?.cache, "no-store");
  equal(calls[0].init?.body, '{"eventJws":"offline"}');
  const headers = new Headers(calls[0].init?.headers);
  ok(!headers.has("host") && !headers.has("authorization") && !headers.has("cookie"));
  equal(headers.get("content-type"), "application/json");
  ok(calls[0].init?.signal instanceof AbortSignal);
  ok(cancelled);
});

test("Worker redirect is one failed delivery and never replays the signed body", async () => {
  let calls = 0;
  const transport = createWorkerTransport(async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/steal" } });
  });
  equal(await transport.webhookSender(target, "signed-body", AbortSignal.timeout(1000)), {
    status: 302,
    ok: false,
  });
  equal(calls, 1);
});

test("Worker rejects unsafe targets and aborted delivery before sending any body", async () => {
  let calls = 0;
  const transport = createWorkerTransport(async () => {
    calls++;
    return new Response(null, { status: 204 });
  });
  for (const url of [
    "http://merchant.example/hook",
    "https://user:password@merchant.example/hook",
    "https://merchant.example/hook#fragment",
  ]) {
    await rejects(
      () =>
        transport.webhookSender(
          { ...target, url: new URL(url) },
          "signed-body",
          AbortSignal.timeout(1000),
        ),
      /invalid_webhook_target/,
    );
  }
  await rejects(() => transport.webhookSender(target, "signed-body", AbortSignal.abort()));
  equal(calls, 0);
});

test("Worker DNS prevalidation rejects mixed public/private answers before signed POST", async () => {
  const kv = new SqliteKv();
  let posts = 0;
  try {
    const transport = createWorkerTransport(async (input, init) => {
      if (init?.method === "POST") posts++;
      const type = new URL(String(input)).searchParams.get("type");
      return Response.json({
        Status: 0,
        Answer:
          type === "A"
            ? [
                { type: 1, data: "93.184.216.34" },
                { type: 1, data: "127.0.0.1" },
              ]
            : [],
      });
    });
    const auth = createMerchantAuthService(kv, { resolveDns: transport.resolveDns });
    await rejects(
      () => auth.resolveWebhookTarget("https://merchant.example/hook"),
      /unsafe_webhook_url/,
    );
    equal(posts, 0);
  } finally {
    kv.close();
  }
});

test("Worker response cancellation failure does not retry an acknowledged payment", async () => {
  const successful = createWorkerTransport(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw new Error("already_closed");
          },
        }),
        { status: 200 },
      ),
  );
  equal(await successful.webhookSender(target, "signed-body", AbortSignal.timeout(1000)), {
    status: 200,
    ok: true,
  });
});

test("Worker request budget fails before extra I/O and a fresh invocation can retry", async () => {
  let calls = 0;
  const fetcher: FetchLike = async () => {
    calls++;
    return new Response(null, { status: 204 });
  };
  const limited = new WorkerRequestBudget(2).wrap(fetcher);
  await limited("https://offline.invalid/1");
  await limited("https://offline.invalid/2");
  await rejects(async () => {
    await limited("https://offline.invalid/3");
  }, WorkerBudgetError);
  equal(calls, 2);
  await new WorkerRequestBudget(2).wrap(fetcher)("https://offline.invalid/retry");
  equal(calls, 3);
});
