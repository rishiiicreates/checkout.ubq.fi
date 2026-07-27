import {
  CHAIN_CONFIGURATIONS,
  normalizeAddress,
  type SupportedChainId,
} from "../src/payment_types.ts";
import {
  type JsonRpcBatchItem,
  type JsonRpcCall,
  type RpcClient,
  RpcError,
  TRANSFER_TOPIC,
} from "../src/rpc.ts";

export const ANVIL_CHAIN_ID = 8453 as const;
export const ANVIL_FORK_BLOCK = 48_933_428;
export const ANVIL_RPC_URL = "http://127.0.0.1:18545";
export const BASE_FORK_URL = "https://mainnet.base.org";
export const DEMO_TREASURY_ADDRESS = "0x5DD4d53Df5d2F578c613D09525dE1A7352250143";

const BASE_USDC_ADDRESS = CHAIN_CONFIGURATIONS[ANVIL_CHAIN_ID].tokenAddress;
const FUNDED_USDC_HOLDER = "0x51c72848c68a965f66fa7a88855f9f7784502a7f";
const STARTUP_ATTEMPTS = 80;
const RECEIPT_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 250;

export type DemoFinality = "network" | "safe" | "finalized";

export type AnvilTransfer = {
  transactionHash: string;
  blockNumber: bigint;
  blockHash: string;
  logIndex: number;
  payerAddress: string;
};

export class AnvilRpcClient implements RpcClient {
  #finality: DemoFinality = "network";

  constructor(private readonly endpoint = ANVIL_RPC_URL) {}

  setFinality(finality: DemoFinality): void {
    this.#finality = finality;
  }

  async batch(
    chainId: SupportedChainId,
    calls: readonly JsonRpcCall[],
  ): Promise<JsonRpcBatchItem[]> {
    if (chainId !== ANVIL_CHAIN_ID) throw new RpcError("anvil_demo_base_only");
    if (calls.length === 0) throw new RpcError("rpc_batch_empty");
    const body = calls.map((call) => ({
      jsonrpc: "2.0",
      id: call.id,
      method: call.method,
      params: this.#mappedParams(call),
    }));
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new RpcError("anvil_transport_failed", error);
    }
    if (!response.ok) throw new RpcError(`anvil_http_${response.status}`);
    const parsed = await response.json().catch((error) => {
      throw new RpcError("anvil_invalid_json", error);
    });
    if (!Array.isArray(parsed)) throw new RpcError("rpc_batch_response_required");
    return parsed as JsonRpcBatchItem[];
  }

  #mappedParams(call: JsonRpcCall): unknown[] {
    if (call.method !== "eth_getBlockByNumber" || call.params.length === 0) {
      return call.params;
    }
    const tag = call.params[0];
    const safeIsLatest = tag === "safe" && this.#finality !== "network";
    const finalizedIsLatest = tag === "finalized" && this.#finality === "finalized";
    return safeIsLatest || finalizedIsLatest ? ["latest", ...call.params.slice(1)] : call.params;
  }
}

export class AnvilBaseFork {
  readonly rpc = new AnvilRpcClient();
  #process: Deno.ChildProcess | null = null;

  async start(): Promise<void> {
    if (this.#process) return;
    if (await rpcAvailable()) {
      throw new Error(`Anvil demo port is already in use: ${ANVIL_RPC_URL}`);
    }
    try {
      this.#process = new Deno.Command("anvil", {
        args: [
          "--fork-url",
          BASE_FORK_URL,
          "--fork-block-number",
          String(ANVIL_FORK_BLOCK),
          "--chain-id",
          String(ANVIL_CHAIN_ID),
          "--host",
          "127.0.0.1",
          "--port",
          new URL(ANVIL_RPC_URL).port,
          "--silent",
        ],
        stdout: "null",
        stderr: "inherit",
      }).spawn();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new Error("Anvil is required. Install Foundry from https://getfoundry.sh/.");
      }
      throw error;
    }

    for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt++) {
      try {
        const chainId = await rpcRequest<string>("eth_chainId", []);
        const blockNumber = await rpcRequest<string>("eth_blockNumber", []);
        if (
          BigInt(chainId) === BigInt(ANVIL_CHAIN_ID) &&
          BigInt(blockNumber) === BigInt(ANVIL_FORK_BLOCK)
        ) return;
      } catch {
        // Anvil is still starting and loading the pinned Base state.
      }
      await delay(POLL_INTERVAL_MS);
    }
    await this.stop();
    throw new Error("Anvil did not load the pinned Base fork within 20 seconds.");
  }

  setFinality(finality: DemoFinality): void {
    this.rpc.setFinality(finality);
  }

  async mine(blocks: number): Promise<void> {
    if (!Number.isSafeInteger(blocks) || blocks < 1) throw new Error("invalid_anvil_block_count");
    await rpcRequest("anvil_mine", [`0x${blocks.toString(16)}`]);
  }

  async snapshot(): Promise<string> {
    return await rpcRequest<string>("evm_snapshot", []);
  }

  async revert(snapshotId: string): Promise<void> {
    const reverted = await rpcRequest<boolean>("evm_revert", [snapshotId]);
    if (!reverted) throw new Error("anvil_snapshot_revert_failed");
  }

  async sendExactUsdc(recipientInput: string, amountUnits: bigint): Promise<AnvilTransfer> {
    const recipient = normalizeAddress(recipientInput);
    if (amountUnits <= 0n) throw new Error("invalid_demo_transfer_amount");
    const balance = await this.usdcBalance(FUNDED_USDC_HOLDER);
    if (balance < amountUnits) throw new Error("pinned_usdc_holder_balance_too_low");

    await rpcRequest("anvil_impersonateAccount", [FUNDED_USDC_HOLDER]);
    try {
      await rpcRequest("anvil_setBalance", [FUNDED_USDC_HOLDER, "0x56bc75e2d63100000"]);
      const transactionHash = await rpcRequest<string>("eth_sendTransaction", [{
        from: FUNDED_USDC_HOLDER,
        to: BASE_USDC_ADDRESS,
        gas: "0x493e0",
        data: transferCalldata(recipient, amountUnits),
      }]);
      const receipt = await waitForReceipt(transactionHash);
      const log = transferLog(receipt, transactionHash, recipient, amountUnits);
      return {
        transactionHash: normalizeHash(transactionHash),
        blockNumber: parseQuantity(receipt.blockNumber, "invalid_demo_receipt_block"),
        blockHash: normalizeHash(receipt.blockHash),
        logIndex: Number(parseQuantity(log.logIndex, "invalid_demo_log_index")),
        payerAddress: FUNDED_USDC_HOLDER,
      };
    } finally {
      await rpcRequest("anvil_stopImpersonatingAccount", [FUNDED_USDC_HOLDER]).catch(() => {});
    }
  }

  async usdcBalance(addressInput: string): Promise<bigint> {
    const address = normalizeAddress(addressInput);
    const data = `0x70a08231${address.slice(2).padStart(64, "0")}`;
    const result = await rpcRequest<string>("eth_call", [
      { to: BASE_USDC_ADDRESS, data },
      "latest",
    ]);
    return BigInt(result);
  }

  async stop(): Promise<void> {
    const process = this.#process;
    this.#process = null;
    if (!process) return;
    try {
      process.kill("SIGTERM");
    } catch {
      // It may already have exited after reporting its startup error.
    }
    await process.status.catch(() => {});
  }
}

async function rpcRequest<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(ANVIL_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`anvil_http_${response.status}`);
  const body = await response.json() as {
    result?: T;
    error?: { code?: unknown; message?: unknown };
  };
  if (body.error) {
    throw new Error(`anvil_rpc_error_${body.error.code}: ${String(body.error.message)}`);
  }
  if (!("result" in body)) throw new Error("anvil_rpc_result_missing");
  return body.result as T;
}

async function rpcAvailable(): Promise<boolean> {
  try {
    await rpcRequest("eth_chainId", []);
    return true;
  } catch {
    return false;
  }
}

async function waitForReceipt(transactionHash: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < RECEIPT_ATTEMPTS; attempt++) {
    const receipt = await rpcRequest<Record<string, unknown> | null>(
      "eth_getTransactionReceipt",
      [transactionHash],
    );
    if (receipt) {
      if (parseQuantity(receipt.status, "invalid_demo_receipt_status") !== 1n) {
        throw new Error("demo_usdc_transfer_failed");
      }
      return receipt;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error("demo_usdc_receipt_timeout");
}

function transferLog(
  receipt: Record<string, unknown>,
  transactionHash: string,
  recipient: string,
  amountUnits: bigint,
): Record<string, unknown> {
  if (!Array.isArray(receipt.logs)) throw new Error("demo_receipt_logs_missing");
  const recipientTopic = `0x${recipient.slice(2).padStart(64, "0")}`;
  const amountWord = `0x${amountUnits.toString(16).padStart(64, "0")}`;
  const log = receipt.logs.find((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const value = candidate as Record<string, unknown>;
    return String(value.address).toLowerCase() === BASE_USDC_ADDRESS.toLowerCase() &&
      value.transactionHash === transactionHash && Array.isArray(value.topics) &&
      value.topics[0] === TRANSFER_TOPIC && value.topics[2] === recipientTopic &&
      value.data === amountWord;
  });
  if (!log || typeof log !== "object" || Array.isArray(log)) {
    throw new Error("demo_usdc_transfer_log_missing");
  }
  return log as Record<string, unknown>;
}

function transferCalldata(recipient: string, amountUnits: bigint): string {
  return "0xa9059cbb" + recipient.slice(2).padStart(64, "0") +
    amountUnits.toString(16).padStart(64, "0");
}

function parseQuantity(value: unknown, code: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/iu.test(value)) {
    throw new Error(code);
  }
  return BigInt(value);
}

function normalizeHash(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/iu.test(value)) {
    throw new Error("invalid_demo_hash");
  }
  return value.toLowerCase();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
