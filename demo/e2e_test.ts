import { assert, assertEquals } from "@std/assert";
import { verifyCompactJws } from "../src/jws.ts";
import { ANVIL_CHAIN_ID, DEMO_TREASURY_ADDRESS } from "./anvil.ts";
import { createDemoEnvironment } from "./server.ts";

type DemoInvoice = {
  id: string;
  status: string;
  chainId: number;
  treasuryAddress: string;
  tokenAddress: string;
  paidAmountUnits: string;
};

type DemoStep = {
  invoice: DemoInvoice;
  transactionHash: string;
  eventJws?: string;
};

Deno.test({
  name: "Anvil Base fork executes and verifies the complete Checkout lifecycle",
  fn: async () => {
    const environment = await createDemoEnvironment();
    let origin = "";
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: (address) => {
        origin = `http://${address.hostname}:${address.port}`;
      },
    }, environment.handler);
    try {
      const page = await fetch(`${origin}/`);
      assertEquals(page.status, 200);
      assert((await page.text()).includes("Take a crypto checkout from invoice to finality"));

      const invoice = await requestJson<DemoInvoice>(`${origin}/api/demo/invoices`, {
        method: "POST",
      });
      assertEquals(invoice.status, "awaiting_payment");
      assertEquals(invoice.chainId, ANVIL_CHAIN_ID);
      assertEquals(invoice.treasuryAddress, DEMO_TREASURY_ADDRESS.toLowerCase());
      assertEquals(invoice.tokenAddress, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
      const treasuryBefore = await environment.anvil.usdcBalance(DEMO_TREASURY_ADDRESS);

      const confirming = await requestJson<DemoStep>(
        `${origin}/api/demo/invoices/${invoice.id}/steps/transfer`,
        { method: "POST" },
      );
      assertEquals(confirming.invoice.status, "confirming");
      assert(/^0x[0-9a-f]{64}$/u.test(confirming.transactionHash));
      const treasuryAfter = await environment.anvil.usdcBalance(DEMO_TREASURY_ADDRESS);
      assertEquals(treasuryAfter - treasuryBefore, BigInt(invoice.paidAmountUnits));

      const provisional = await requestJson<DemoStep>(
        `${origin}/api/demo/invoices/${invoice.id}/steps/confirm`,
        { method: "POST" },
      );
      assertEquals(provisional.invoice.status, "provisionally_paid");
      assert(typeof provisional.eventJws === "string");
      const acceptedPayload = (await verifyCompactJws(
        provisional.eventJws!,
        await environment.services.payment.jwks(),
      )).payload as Record<string, unknown>;
      assertEquals(acceptedPayload.type, "payment.accepted.v1");
      assertEquals(acceptedPayload.txHash, confirming.transactionHash);
      assertEquals(acceptedPayload.treasuryAddress, invoice.treasuryAddress);

      const settled = await requestJson<DemoStep>(
        `${origin}/api/demo/invoices/${invoice.id}/steps/settle`,
        { method: "POST" },
      );
      assertEquals(settled.invoice.status, "settled");
      assert(typeof settled.eventJws === "string");

      const finalized = await requestJson<DemoStep>(
        `${origin}/api/demo/invoices/${invoice.id}/steps/finalize`,
        { method: "POST" },
      );
      assertEquals(finalized.invoice.status, "finalized");
      assertEquals(finalized.transactionHash, confirming.transactionHash);
    } finally {
      await server.shutdown();
      await environment.close();
    }
  },
});

Deno.test({
  name: "Anvil Base fork emits a signed reversion after provisional acceptance is reorged out",
  fn: async () => {
    const environment = await createDemoEnvironment();
    try {
      const origin = "http://127.0.0.1:8010";
      const invoice = await requestHandlerJson<DemoInvoice>(
        environment.handler,
        `${origin}/api/demo/invoices`,
        { method: "POST" },
      );
      const snapshotId = await environment.anvil.snapshot();
      const confirming = await requestHandlerJson<DemoStep>(
        environment.handler,
        `${origin}/api/demo/invoices/${invoice.id}/steps/transfer`,
        { method: "POST" },
      );
      assertEquals(confirming.invoice.status, "confirming");
      const provisional = await requestHandlerJson<DemoStep>(
        environment.handler,
        `${origin}/api/demo/invoices/${invoice.id}/steps/confirm`,
        { method: "POST" },
      );
      assertEquals(provisional.invoice.status, "provisionally_paid");

      await environment.anvil.revert(snapshotId);
      await environment.anvil.mine(1);
      const reverted = await environment.services.payment.refreshInvoice(invoice.id);
      assertEquals(reverted.invoice.status, "reverted");
      assert(typeof reverted.eventJws === "string");
      const payload = (await verifyCompactJws(
        reverted.eventJws!,
        await environment.services.payment.jwks(),
      )).payload as Record<string, unknown>;
      assertEquals(payload.type, "payment.reverted.v1");
      assertEquals(payload.reason, "non_canonical_block");
      assertEquals(payload.txHash, confirming.transactionHash);
    } finally {
      await environment.close();
    }
  },
});

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${JSON.stringify(body)}`);
  return body as T;
}

async function requestHandlerJson<T>(
  handler: (request: Request) => Promise<Response>,
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await handler(new Request(url, init));
  const body = await response.json();
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${JSON.stringify(body)}`);
  return body as T;
}
