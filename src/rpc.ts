import {
  normalizeAddress,
  normalizeTransactionHash,
  type SupportedChainId,
} from "./payment_types.ts";

export const RPC_ORIGIN = "https://rpc.ubq.fi";
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type JsonRpcCall = {
  id: string;
  method: string;
  params: unknown[];
};

export type JsonRpcBatchItem = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
};

export interface RpcClient {
  batch(chainId: SupportedChainId, calls: readonly JsonRpcCall[]): Promise<JsonRpcBatchItem[]>;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class HttpRpcClient implements RpcClient {
  constructor(
    private readonly fetcher: FetchLike = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async batch(
    chainId: SupportedChainId,
    calls: readonly JsonRpcCall[],
  ): Promise<JsonRpcBatchItem[]> {
    if (calls.length === 0) throw new RpcError("rpc_batch_empty");
    const body = calls.map((call) => ({
      jsonrpc: "2.0",
      id: call.id,
      method: call.method,
      params: call.params,
    }));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new RpcError("rpc_timeout");
        reject(error);
        controller.abort(error);
      }, this.timeoutMs);
    });
    try {
      let response: Response;
      try {
        response = await Promise.race([
          this.fetcher(`${RPC_ORIGIN}/${chainId}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          }),
          deadline,
        ]);
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new RpcError("rpc_transport_failed", error);
      }
      if (!response.ok) throw new RpcError(`rpc_http_${response.status}`);
      let parsed: unknown;
      try {
        parsed = await Promise.race([response.json(), deadline]);
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new RpcError("rpc_invalid_json", error);
      }
      if (!Array.isArray(parsed)) throw new RpcError("rpc_batch_response_required");
      return parsed as JsonRpcBatchItem[];
    } finally {
      clearTimeout(timer!);
    }
  }
}

export type TransferLocator = {
  transactionHash: string;
  logIndex: number;
  observedBlockNumber: bigint;
  observedBlockHash?: string;
};

export type ExpectedTransfer = TransferLocator & {
  tokenAddress: string;
  recipientAddress: string;
  amountUnits: bigint;
  previouslyVerifiedBlockHash?: string;
};

export type VerifiedTransfer = {
  transactionHash: string;
  logIndex: number;
  payerAddress: string;
  tokenAddress: string;
  recipientAddress: string;
  amountUnits: bigint;
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: Date;
  latestBlock: bigint;
  safeBlock: bigint | null;
  finalizedBlock: bigint | null;
};

export type ChainHeads = {
  latestBlock: bigint;
  safeBlock: bigint | null;
  finalizedBlock: bigint | null;
};

export type DiscoveredTransferLog = {
  transactionHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash: string;
  tokenAddress: string;
  payerAddress: string;
  recipientAddress: string;
  amountUnits: bigint;
};

export async function latestBlockNumber(
  client: RpcClient,
  chainId: SupportedChainId,
): Promise<bigint> {
  const calls: JsonRpcCall[] = [{
    id: "latest",
    method: "eth_getBlockByNumber",
    params: ["latest", false],
  }];
  const results = responseMap(await client.batch(chainId, calls), calls);
  return parseBlock(results.get("latest"), "latest").number;
}

export async function chainHeads(
  client: RpcClient,
  chainId: SupportedChainId,
): Promise<ChainHeads> {
  const calls: JsonRpcCall[] = ["latest", "safe", "finalized"].map((id) => ({
    id,
    method: "eth_getBlockByNumber",
    params: [id, false],
  }));
  const results = responseMap(await client.batch(chainId, calls), calls);
  const latest = parseBlock(results.get("latest"), "latest");
  const safe = parseOptionalBlock(results.get("safe"), "safe");
  const finalized = parseOptionalBlock(results.get("finalized"), "finalized");
  return validateChainHeads({
    latestBlock: latest.number,
    safeBlock: safe?.number ?? null,
    finalizedBlock: finalized?.number ?? null,
  });
}

export async function discoverTransferLogs(
  client: RpcClient,
  chainId: SupportedChainId,
  tokenAddressInput: string,
  recipientAddressInput: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<DiscoveredTransferLog[]> {
  if (fromBlock < 0n || toBlock < fromBlock) throw new RpcError("invalid_log_range");
  const logs: DiscoveredTransferLog[] = [];
  // Bound provider range/response sizes for long-lived invoices. Smaller provider
  // limits are handled by bisecting failed ranges down to a single block.
  for (let start = fromBlock; start <= toBlock; start += 1_000n) {
    const end = start + 999n < toBlock ? start + 999n : toBlock;
    logs.push(...await discoverRange(start, end));
  }
  return logs;

  async function discoverRange(start: bigint, end: bigint): Promise<DiscoveredTransferLog[]> {
    try {
      return await discoverTransferLogChunk(
        client,
        chainId,
        tokenAddressInput,
        recipientAddressInput,
        start,
        end,
      );
    } catch (error) {
      if (
        !(error instanceof RpcError) || start === end ||
        !error.code.startsWith("rpc_upstream_error:transfer_logs:") ||
        /rate.?limit|too many requests|quota|throttl|request limit/i.test(error.code) ||
        !/block.{0,16}range|range.{0,32}(?:large|wide|limit|exceed)|(?:response|result|log|payload).{0,16}size|too many (?:results|logs)|query returned more than \d+ results|(?:max(?:imum)?|limit).{0,16}(?:blocks|results|logs)/i
          .test(error.code)
      ) {
        throw error;
      }
      const middle = (start + end) / 2n;
      return [...await discoverRange(start, middle), ...await discoverRange(middle + 1n, end)];
    }
  }
}

async function discoverTransferLogChunk(
  client: RpcClient,
  chainId: SupportedChainId,
  tokenAddressInput: string,
  recipientAddressInput: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<DiscoveredTransferLog[]> {
  const tokenAddress = normalizeAddress(tokenAddressInput);
  const recipientAddress = normalizeAddress(recipientAddressInput);
  const calls: JsonRpcCall[] = [{
    id: "transfer_logs",
    method: "eth_getLogs",
    params: [{
      address: tokenAddress,
      fromBlock: toQuantity(fromBlock),
      toBlock: toQuantity(toBlock),
      topics: [TRANSFER_TOPIC, null, addressTopic(recipientAddress)],
    }],
  }];
  const results = responseMap(await client.batch(chainId, calls), calls);
  const rawLogs = results.get("transfer_logs");
  if (!Array.isArray(rawLogs)) throw new RpcError("rpc_transfer_logs_array_required");
  return rawLogs.filter((value) =>
    !!value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).removed !== true
  ).map((value): DiscoveredTransferLog => {
    const log = value as Record<string, unknown>;
    if (normalizeAddressForVerification(log.address) !== tokenAddress) {
      throw new RpcError("rpc_transfer_log_token_mismatch");
    }
    if (!Array.isArray(log.topics) || log.topics.length !== 3) {
      throw new RpcError("rpc_transfer_log_topics_invalid");
    }
    const topics = log.topics.map((topic) => hexWord(topic, "invalid_transfer_topic"));
    if (topics[0] !== TRANSFER_TOPIC) throw new RpcError("rpc_transfer_log_signature_invalid");
    const logIndex = parseQuantity(log.logIndex, "invalid_log_index");
    if (logIndex > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RpcError("rpc_transfer_log_index_too_large");
    }
    const discoveredRecipient = topicAddress(topics[2], "invalid_transfer_recipient");
    if (discoveredRecipient !== recipientAddress) {
      throw new RpcError("rpc_transfer_log_recipient_mismatch");
    }
    return {
      transactionHash: hexHash(log.transactionHash, "invalid_log_transaction_hash"),
      logIndex: Number(logIndex),
      blockNumber: parseQuantity(log.blockNumber, "invalid_log_block_number"),
      blockHash: hexHash(log.blockHash, "invalid_log_block_hash"),
      tokenAddress,
      payerAddress: topicAddress(topics[1], "invalid_transfer_payer"),
      recipientAddress: discoveredRecipient,
      amountUnits: parseWord(log.data, "invalid_transfer_amount"),
    };
  }).filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
}

export async function verifyTransferBatch(
  client: RpcClient,
  chainId: SupportedChainId,
  expectedInput: ExpectedTransfer,
): Promise<VerifiedTransfer> {
  const transactionHash = normalizeTransactionHash(expectedInput.transactionHash);
  const tokenAddress = normalizeAddress(expectedInput.tokenAddress);
  const recipientAddress = normalizeAddress(expectedInput.recipientAddress);
  const { logIndex, observedBlockNumber, amountUnits } = expectedInput;
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) {
    throw new RpcVerificationError("invalid_log_index");
  }
  if (observedBlockNumber < 0n) {
    throw new RpcVerificationError("invalid_observed_block_number");
  }
  if (amountUnits <= 0n) throw new RpcVerificationError("invalid_expected_amount");
  if (
    expectedInput.observedBlockHash !== undefined &&
    !/^0x[0-9a-fA-F]{64}$/.test(expectedInput.observedBlockHash)
  ) {
    throw new RpcVerificationError("invalid_observed_block_hash");
  }
  const previouslyVerifiedBlockHash = expectedInput.previouslyVerifiedBlockHash === undefined
    ? undefined
    : hexHash(expectedInput.previouslyVerifiedBlockHash, "invalid_previously_verified_block_hash");

  const calls: JsonRpcCall[] = [
    {
      id: "receipt",
      method: "eth_getTransactionReceipt",
      params: [transactionHash],
    },
    {
      id: "event_block",
      method: "eth_getBlockByNumber",
      params: [toQuantity(observedBlockNumber), false],
    },
    {
      id: "latest",
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    },
    {
      id: "safe",
      method: "eth_getBlockByNumber",
      params: ["safe", false],
    },
    {
      id: "finalized",
      method: "eth_getBlockByNumber",
      params: ["finalized", false],
    },
  ];

  // All canonical evidence and provider heads deliberately share this one batch/upstream request.
  const results = responseMap(await client.batch(chainId, calls), calls);
  const eventBlock = parseBlock(results.get("event_block"), "event_block");
  if (
    previouslyVerifiedBlockHash !== undefined &&
    (eventBlock.number !== observedBlockNumber || eventBlock.hash !== previouslyVerifiedBlockHash)
  ) {
    throw new RpcVerificationError("non_canonical_block", true);
  }
  const receipt = objectResult(results.get("receipt"), "receipt_not_found");
  const receiptTransactionHash = hexHash(
    receipt.transactionHash,
    "invalid_receipt_transaction_hash",
  );
  if (receiptTransactionHash !== transactionHash) {
    throw new RpcVerificationError("receipt_transaction_hash_mismatch");
  }
  if (parseQuantity(receipt.status, "invalid_receipt_status") !== 1n) {
    throw new RpcVerificationError("transaction_failed");
  }
  const receiptBlockNumber = parseQuantity(receipt.blockNumber, "invalid_receipt_block_number");
  if (receiptBlockNumber !== observedBlockNumber) {
    throw new RpcVerificationError("observed_block_number_mismatch");
  }
  const receiptBlockHash = hexHash(receipt.blockHash, "invalid_receipt_block_hash");

  if (eventBlock.number !== receiptBlockNumber || eventBlock.hash !== receiptBlockHash) {
    throw new RpcVerificationError("non_canonical_block");
  }

  if (!Array.isArray(receipt.logs)) {
    throw new RpcVerificationError("receipt_logs_missing");
  }
  const rawLog = receipt.logs.find((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    try {
      return parseQuantity(
        (value as Record<string, unknown>).logIndex,
        "invalid_log_index",
      ) === BigInt(logIndex);
    } catch {
      return false;
    }
  });
  if (!rawLog || typeof rawLog !== "object" || Array.isArray(rawLog)) {
    throw new RpcVerificationError("transfer_log_not_found");
  }
  const log = rawLog as Record<string, unknown>;
  if (log.removed === true) {
    throw new RpcVerificationError("transfer_log_removed");
  }
  if (normalizeAddressForVerification(log.address) !== tokenAddress) {
    throw new RpcVerificationError("wrong_token_address");
  }
  if (hexHash(log.transactionHash, "invalid_log_transaction_hash") !== transactionHash) {
    throw new RpcVerificationError("log_transaction_hash_mismatch");
  }
  if (parseQuantity(log.blockNumber, "invalid_log_block_number") !== receiptBlockNumber) {
    throw new RpcVerificationError("log_block_number_mismatch");
  }
  if (hexHash(log.blockHash, "invalid_log_block_hash") !== receiptBlockHash) {
    throw new RpcVerificationError("log_block_hash_mismatch");
  }

  if (!Array.isArray(log.topics) || log.topics.length !== 3) {
    throw new RpcVerificationError("invalid_transfer_topics");
  }
  const topics = log.topics.map((topic) => hexWord(topic, "invalid_transfer_topic"));
  if (topics[0] !== TRANSFER_TOPIC) {
    throw new RpcVerificationError("wrong_event_signature");
  }
  const payerAddress = topicAddress(topics[1], "invalid_transfer_payer");
  if (topics[2] !== addressTopic(recipientAddress)) {
    throw new RpcVerificationError("wrong_transfer_recipient");
  }
  const loggedAmount = parseWord(log.data, "invalid_transfer_amount");
  if (loggedAmount !== amountUnits) {
    throw new RpcVerificationError("wrong_transfer_amount");
  }

  const latest = parseBlock(results.get("latest"), "latest");
  const safe = parseOptionalBlock(results.get("safe"), "safe");
  const finalized = parseOptionalBlock(results.get("finalized"), "finalized");
  const heads = validateChainHeads({
    latestBlock: latest.number,
    safeBlock: safe?.number ?? null,
    finalizedBlock: finalized?.number ?? null,
  });
  return {
    transactionHash,
    logIndex,
    payerAddress,
    tokenAddress,
    recipientAddress,
    amountUnits,
    blockNumber: receiptBlockNumber,
    blockHash: receiptBlockHash,
    blockTimestamp: new Date(Number(eventBlock.timestamp * 1000n)),
    ...heads,
  };
}

function validateChainHeads(heads: ChainHeads): ChainHeads {
  if (
    (heads.safeBlock !== null && heads.safeBlock > heads.latestBlock) ||
    (heads.finalizedBlock !== null &&
      (heads.safeBlock === null || heads.finalizedBlock > heads.safeBlock))
  ) {
    throw new RpcError("rpc_incoherent_chain_heads");
  }
  return heads;
}

export class RpcError extends Error {
  constructor(
    public readonly code: string,
    public override readonly cause?: unknown,
  ) {
    super(code);
    this.name = "RpcError";
  }
}

export class RpcVerificationError extends Error {
  constructor(
    public readonly code: string,
    public readonly canonicalContradiction = false,
  ) {
    super(code);
    this.name = "RpcVerificationError";
  }
}

function responseMap(
  responses: JsonRpcBatchItem[],
  calls: readonly JsonRpcCall[],
): Map<string, unknown> {
  const expected = new Set(calls.map((call) => call.id));
  const results = new Map<string, unknown>();
  for (const response of responses) {
    if (!response || typeof response !== "object" || response.jsonrpc !== "2.0") {
      throw new RpcError("rpc_invalid_batch_item");
    }
    if (typeof response.id !== "string" || !expected.has(response.id)) {
      throw new RpcError("rpc_unexpected_response_id");
    }
    if (results.has(response.id)) throw new RpcError("rpc_duplicate_response_id");
    if (response.error !== undefined) {
      const message = typeof response.error?.message === "string"
        ? response.error.message
        : "unknown upstream error";
      throw new RpcError(`rpc_upstream_error:${response.id}:${message}`);
    }
    results.set(response.id, response.result);
  }
  for (const id of expected) {
    if (!results.has(id)) throw new RpcError(`rpc_missing_response:${id}`);
  }
  return results;
}

function objectResult(value: unknown, missingCode: string): Record<string, unknown> {
  if (value === null || value === undefined) throw new RpcVerificationError(missingCode);
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RpcVerificationError(`invalid_${missingCode}`);
  }
  return value as Record<string, unknown>;
}

function parseBlock(value: unknown, label: string): {
  number: bigint;
  hash: string;
  timestamp: bigint;
} {
  const block = objectResult(value, `${label}_block_not_found`);
  return {
    number: parseQuantity(block.number, `invalid_${label}_block_number`),
    hash: hexHash(block.hash, `invalid_${label}_block_hash`),
    timestamp: parseQuantity(block.timestamp, `invalid_${label}_block_timestamp`),
  };
}

function parseOptionalBlock(
  value: unknown,
  label: string,
): { number: bigint; hash: string; timestamp: bigint } | null {
  if (value === null) return null;
  return parseBlock(value, label);
}

function normalizeAddressForVerification(value: unknown): string {
  try {
    return normalizeAddress(value);
  } catch {
    throw new RpcVerificationError("invalid_log_address");
  }
}

function parseQuantity(value: unknown, code: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new RpcVerificationError(code);
  }
  return BigInt(value);
}

function parseWord(value: unknown, code: string): bigint {
  return BigInt(hexWord(value, code));
}

function hexHash(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new RpcVerificationError(code);
  }
  return value.toLowerCase();
}

function hexWord(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new RpcVerificationError(code);
  }
  return value.toLowerCase();
}

function addressTopic(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2)}`;
}

function topicAddress(topic: string, code: string): string {
  if (!topic.startsWith(`0x${"0".repeat(24)}`)) throw new RpcVerificationError(code);
  return `0x${topic.slice(-40)}`;
}

function toQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}
