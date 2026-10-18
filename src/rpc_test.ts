import {
  chainHeads,
  discoverTransferLogs,
  HttpRpcClient,
  type JsonRpcBatchItem,
  type JsonRpcCall,
  type RpcClient,
  RpcError,
  RpcVerificationError,
  TRANSFER_TOPIC,
  verifyTransferBatch,
} from "./rpc.ts";
import { CHAIN_CONFIGURATIONS } from "./payment_types.ts";

const TRANSACTION_HASH = `0x${"11".repeat(32)}`;
const BLOCK_HASH = `0x${"22".repeat(32)}`;
const PAYER = `0x${"33".repeat(20)}`;
const RECIPIENT = `0x${"44".repeat(20)}`;
const TOKEN = CHAIN_CONFIGURATIONS[8453].tokenAddress;
const AMOUNT = 999_999n;

Deno.test("RPC deadlines abort stalled fetches and response bodies", async (t) => {
  const calls = [{ id: "latest", method: "eth_blockNumber", params: [] }];
  await t.step("a fetch that ignores cancellation still settles by its deadline", async () => {
    let signal: AbortSignal | null | undefined;
    const release = Promise.withResolvers<Response>();
    const client = new HttpRpcClient((_input, init) => {
      signal = init?.signal;
      return release.promise;
    }, 10);
    try {
      await assertRejectsRpcCode(() => client.batch(8453, calls), "rpc_timeout");
      assertEquals(signal?.aborted, true);
    } finally {
      release.resolve(Response.json([]));
    }
  });
  await t.step("a received response body shares the request deadline", async () => {
    let signal: AbortSignal | null | undefined;
    let cancelled = false;
    const client = new HttpRpcClient((_input, init) => {
      signal = init?.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("["));
              signal?.addEventListener("abort", () => {
                cancelled = true;
                controller.error(signal?.reason);
              }, { once: true });
            },
          }),
        ),
      );
    }, 10);
    await assertRejectsRpcCode(() => client.batch(8453, calls), "rpc_timeout");
    assertEquals(signal?.aborted, true);
    assertEquals(cancelled, true);
  });
});

Deno.test("payment evidence is verified from one HTTP JSON batch", async () => {
  let requestCount = 0;
  let requestUrl = "";
  let requestBody: Array<{ id: string; method: string; params: unknown[] }> = [];
  const client = new HttpRpcClient((input, init) => {
    requestCount++;
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body));
    return Promise.resolve(Response.json(batchResponse(requestBody)));
  });

  const verified = await verifyTransferBatch(client, 8453, expected());
  assertEquals(requestCount, 1);
  assertEquals(requestUrl, "https://rpc.ubq.fi/8453");
  assertEquals(requestBody.length, 5);
  assertEquals(requestBody.map((call) => call.method), [
    "eth_getTransactionReceipt",
    "eth_getBlockByNumber",
    "eth_getBlockByNumber",
    "eth_getBlockByNumber",
    "eth_getBlockByNumber",
  ]);
  assertEquals(requestBody[1].params[0], "0x64");
  assertEquals(verified.blockNumber, 100n);
  assertEquals(verified.latestBlock, 103n);
  assertEquals(verified.safeBlock, 101n);
  assertEquals(verified.finalizedBlock, 99n);
  assertEquals(verified.payerAddress, PAYER);
  assertEquals(verified.blockTimestamp.toISOString(), "2023-11-14T22:13:20.000Z");
});

Deno.test("wrong token, recipient, amount, failed receipts, and noncanonical blocks are rejected", async (t) => {
  await t.step("wrong recipient", async () => {
    const client = mockClient((calls) =>
      batchResponse(calls, { recipient: `0x${"55".repeat(20)}` })
    );
    await assertRejectsCode(
      () => verifyTransferBatch(client, 8453, expected()),
      "wrong_transfer_recipient",
    );
  });
  await t.step("wrong amount", async () => {
    const client = mockClient((calls) => batchResponse(calls, { amount: AMOUNT + 1n }));
    await assertRejectsCode(
      () => verifyTransferBatch(client, 8453, expected()),
      "wrong_transfer_amount",
    );
  });
  await t.step("failed receipt", async () => {
    const client = mockClient((calls) => batchResponse(calls, { status: "0x0" }));
    await assertRejectsCode(
      () => verifyTransferBatch(client, 8453, expected()),
      "transaction_failed",
    );
  });
  await t.step("orphaned receipt block", async () => {
    const client = mockClient((calls) =>
      batchResponse(calls, { canonicalHash: `0x${"66".repeat(32)}` })
    );
    await assertRejectsCode(
      () => verifyTransferBatch(client, 8453, expected()),
      "non_canonical_block",
    );
  });
  await t.step("missing receipt", async () => {
    const client = mockClient((calls) => batchResponse(calls, { receipt: null }));
    await assertRejectsCode(
      () => verifyTransferBatch(client, 8453, expected()),
      "receipt_not_found",
    );
  });
});

Deno.test("browser block hash is not trusted as canonical evidence", async () => {
  const client = mockClient((calls) => batchResponse(calls));
  const verified = await verifyTransferBatch(client, 8453, {
    ...expected(),
    observedBlockHash: `0x${"ff".repeat(32)}`,
  });
  assertEquals(verified.blockHash, BLOCK_HASH);
});

Deno.test("RPC head snapshots require finalized <= safe <= latest", async () => {
  const incoherent = mockClient((calls) =>
    batchResponse(calls, { latest: 100n, safe: 101n, finalized: 99n })
  );
  await assertRejectsRpcCode(() => chainHeads(incoherent, 8453), "rpc_incoherent_chain_heads");
  await assertRejectsRpcCode(
    () => verifyTransferBatch(incoherent, 8453, expected()),
    "rpc_incoherent_chain_heads",
  );
});

Deno.test("reconciliation log discovery is constrained by token and indexed treasury", async () => {
  let captured: readonly JsonRpcCall[] = [];
  const client: RpcClient = {
    batch: (_chainId, calls) => {
      captured = calls;
      return Promise.resolve([{ jsonrpc: "2.0", id: "transfer_logs", result: [] }]);
    },
  };
  assertEquals(
    await discoverTransferLogs(client, 8453, TOKEN, RECIPIENT, 100n, 200n),
    [],
  );
  assertEquals(captured.length, 1);
  assertEquals(captured[0].method, "eth_getLogs");
  const filter = captured[0].params[0] as Record<string, unknown>;
  assertEquals(filter.address, TOKEN.toLowerCase());
  assertEquals(filter.fromBlock, "0x64");
  assertEquals(filter.toBlock, "0xc8");
  assertEquals(filter.topics, [TRANSFER_TOPIC, null, addressTopic(RECIPIENT)]);
});

Deno.test("discovery chunks long ranges and bisects provider range limits without gaps", async () => {
  const successful: [bigint, bigint][] = [];
  const client: RpcClient = {
    batch: (_chainId, calls) => {
      const range = calls[0].params[0] as { fromBlock: string; toBlock: string };
      const from = BigInt(range.fromBlock);
      const to = BigInt(range.toBlock);
      if (to - from >= 300n) {
        return Promise.resolve([{
          jsonrpc: "2.0",
          id: "transfer_logs",
          error: { code: -32005, message: "block range limit exceeded" },
        }]);
      }
      successful.push([from, to]);
      return Promise.resolve([{ jsonrpc: "2.0", id: "transfer_logs", result: [] }]);
    },
  };
  assertEquals(await discoverTransferLogs(client, 8453, TOKEN, RECIPIENT, 100n, 2_600n), []);
  assertEquals(successful[0][0], 100n);
  assertEquals(successful.at(-1)![1], 2_600n);
  for (let index = 1; index < successful.length; index++) {
    assertEquals(successful[index][0], successful[index - 1][1] + 1n);
  }
});

Deno.test("discovery never bisects rate, quota, or throttling errors", async () => {
  for (
    const message of [
      "rate limit exceeded",
      "too many requests",
      "quota exceeded",
      "request limit exceeded",
      "throttled: block range temporarily unavailable",
    ]
  ) {
    let calls = 0;
    const client: RpcClient = {
      batch() {
        calls++;
        return Promise.resolve([{
          jsonrpc: "2.0",
          id: "transfer_logs",
          error: { code: -32005, message },
        }]);
      },
    };
    await assertRejectsRpcCode(
      () => discoverTransferLogs(client, 8453, TOKEN, RECIPIENT, 100n, 1_099n),
      `rpc_upstream_error:transfer_logs:${message}`,
    );
    assertEquals(calls, 1);
  }
});

Deno.test("discovery still bisects explicit result-count limits", async () => {
  let calls = 0;
  const client: RpcClient = {
    batch(_chainId, requests) {
      calls++;
      const filter = requests[0].params[0] as { fromBlock: string; toBlock: string };
      return Promise.resolve([
        BigInt(filter.toBlock) - BigInt(filter.fromBlock) > 249n
          ? {
            jsonrpc: "2.0",
            id: "transfer_logs",
            error: { message: "query returned more than 10000 results" },
          }
          : { jsonrpc: "2.0", id: "transfer_logs", result: [] },
      ]);
    },
  };
  assertEquals(await discoverTransferLogs(client, 8453, TOKEN, RECIPIENT, 100n, 1_099n), []);
  assertEquals(calls, 7);
});

function expected() {
  return {
    transactionHash: TRANSACTION_HASH,
    logIndex: 7,
    observedBlockNumber: 100n,
    observedBlockHash: BLOCK_HASH,
    tokenAddress: TOKEN,
    recipientAddress: RECIPIENT,
    amountUnits: AMOUNT,
  };
}

function mockClient(
  responder: (calls: readonly JsonRpcCall[]) => JsonRpcBatchItem[],
): RpcClient {
  return { batch: (_chainId, calls) => Promise.resolve(responder(calls)) };
}

function batchResponse(
  calls: readonly { id: string; method: string; params: unknown[] }[],
  override: {
    recipient?: string;
    amount?: bigint;
    status?: string;
    canonicalHash?: string;
    receipt?: null;
    latest?: bigint;
    safe?: bigint;
    finalized?: bigint;
  } = {},
): JsonRpcBatchItem[] {
  const recipient = override.recipient ?? RECIPIENT;
  const amount = override.amount ?? AMOUNT;
  const values: Record<string, unknown> = {
    receipt: override.receipt === null ? null : {
      transactionHash: TRANSACTION_HASH,
      blockNumber: "0x64",
      blockHash: BLOCK_HASH,
      status: override.status ?? "0x1",
      logs: [{
        address: TOKEN,
        transactionHash: TRANSACTION_HASH,
        blockNumber: "0x64",
        blockHash: BLOCK_HASH,
        logIndex: "0x7",
        removed: false,
        topics: [TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(recipient)],
        data: word(amount),
      }],
    },
    event_block: block("0x64", override.canonicalHash ?? BLOCK_HASH, "0x6553f100"),
    latest: block(`0x${(override.latest ?? 103n).toString(16)}`, `0x${"77".repeat(32)}`),
    safe: block(`0x${(override.safe ?? 101n).toString(16)}`, `0x${"88".repeat(32)}`),
    finalized: block(
      `0x${(override.finalized ?? 99n).toString(16)}`,
      `0x${"99".repeat(32)}`,
    ),
  };
  return calls.map((call) => ({ jsonrpc: "2.0", id: call.id, result: values[call.id] }));
}

function block(number: string, hash: string, timestamp = "0x6553f101") {
  return { number, hash, timestamp };
}

function addressTopic(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

async function assertRejectsCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof RpcVerificationError && error.code === code) return;
    throw new Error(`Expected ${code}, got ${String(error)}`);
  }
  throw new Error(`Expected rejection ${code}`);
}

async function assertRejectsRpcCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof RpcError && error.code === code) return;
    throw new Error(`Expected ${code}, got ${String(error)}`);
  }
  throw new Error(`Expected rejection ${code}`);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(`Expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

function deepEqual(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "bigint" || typeof expected === "bigint") return actual === expected;
  return JSON.stringify(actual) === JSON.stringify(expected);
}
