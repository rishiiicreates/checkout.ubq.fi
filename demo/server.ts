import {
  type CheckoutServices,
  createCheckoutServices,
  createHandler,
  withPeerAddress,
} from "../main.ts";
import type { InvoiceJson, InvoiceRecord } from "../src/payment_types.ts";
import { ANVIL_CHAIN_ID, AnvilBaseFork, DEMO_TREASURY_ADDRESS } from "./anvil.ts";

const STATIC_ROOT = new URL("./", import.meta.url);
const DEMO_MERCHANT_ID = "linkedin-scraper-2025";
const DEMO_PRICING_VERSION = "anvil-base-fork-v1";
const DEMO_PRODUCT_ID = "anvil:solo-plan";
const DEMO_PRICE_CENTS = 500;

type DemoTransferState = {
  transactionHash: string;
  logIndex: number;
  observedBlockNumber: string;
  observedBlockHash: string;
};

export type DemoEnvironment = {
  anvil: AnvilBaseFork;
  services: CheckoutServices;
  handler: (request: Request) => Promise<Response>;
  close(): Promise<void>;
};

type DemoEnvironmentOptions = {
  anvil?: AnvilBaseFork;
  openKv?: () => Promise<Deno.Kv>;
};

export async function createDemoEnvironment(
  options: DemoEnvironmentOptions = {},
): Promise<DemoEnvironment> {
  const anvil = options.anvil ?? new AnvilBaseFork();
  let kv: Deno.Kv | undefined;
  try {
    await anvil.start();
    kv = await (options.openKv ?? (() => Deno.openKv(":memory:")))();
    const openedKv = kv;
    const services = createCheckoutServices(openedKv, { rpc: anvil.rpc });
    const checkoutHandler = createHandler(services);
    const transfers = new Map<string, DemoTransferState>();
    let closed = false;
    await services.payment.configureChain(ANVIL_CHAIN_ID, {
      enabled: true,
      treasuryAddress: DEMO_TREASURY_ADDRESS,
    });
    await services.payment.publishCatalogVersion(
      { merchantId: DEMO_MERCHANT_ID },
      DEMO_PRICING_VERSION,
      {
        currency: "USD",
        products: [{
          productId: DEMO_PRODUCT_ID,
          label: "Solo test plan",
          kind: "prepaid_plan",
          priceCents: DEMO_PRICE_CENTS,
          enabled: true,
        }],
      },
    );

    return {
      anvil,
      services,
      handler: async (request) => {
        try {
          const url = new URL(request.url);
          if (request.method === "GET" || request.method === "HEAD") {
            const staticResponse = await demoStatic(request.method, url.pathname);
            if (staticResponse) return staticResponse;
          }
          if (url.pathname === "/api/demo/invoices" && request.method === "POST") {
            anvil.setFinality("network");
            return await createInvoice(checkoutHandler, request.url);
          }
          const invoiceMatch = url.pathname.match(/^\/api\/demo\/invoices\/([^/]+)$/u);
          if (invoiceMatch && request.method === "GET") {
            return json(await services.payment.getInvoice(decodeURIComponent(invoiceMatch[1])));
          }
          const stepMatch = url.pathname.match(
            /^\/api\/demo\/invoices\/([^/]+)\/steps\/(transfer|confirm|settle|finalize)$/u,
          );
          if (stepMatch && request.method === "POST") {
            return await advanceInvoice(
              services,
              checkoutHandler,
              anvil,
              transfers,
              decodeURIComponent(stepMatch[1]),
              stepMatch[2],
              request.url,
            );
          }
          return json({ error: "not_found" }, { status: 404 });
        } catch (error) {
          const status = error instanceof DemoConflict ? 409 : 500;
          if (status === 500) console.error("anvil_demo_request_failed", error);
          return json(
            { error: error instanceof Error ? error.message : "demo_internal_error" },
            { status },
          );
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        openedKv.close();
        await anvil.stop();
      },
    };
  } catch (error) {
    kv?.close();
    await anvil.stop();
    throw error;
  }
}

async function createInvoice(
  checkoutHandler: (request: Request) => Promise<Response>,
  requestUrl: string,
): Promise<Response> {
  const response = await checkoutRequest(checkoutHandler, requestUrl, "/api/v1/invoices", {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: {
      customerReference: `anvil-demo-${crypto.randomUUID()}`,
      pricingVersionId: DEMO_PRICING_VERSION,
      productId: DEMO_PRODUCT_ID,
      chainId: ANVIL_CHAIN_ID,
    },
  });
  return cloneJsonResponse(response);
}

async function advanceInvoice(
  services: CheckoutServices,
  checkoutHandler: (request: Request) => Promise<Response>,
  anvil: AnvilBaseFork,
  transfers: Map<string, DemoTransferState>,
  invoiceId: string,
  step: string,
  requestUrl: string,
): Promise<Response> {
  const invoice = await demoInvoice(services, invoiceId);
  let transfer = transfers.get(invoiceId);
  if (step === "transfer") {
    requireStatus(invoice, "awaiting_payment");
    const sent = await anvil.sendExactUsdc(
      invoice.treasuryAddress,
      BigInt(invoice.paidAmountUnits),
    );
    transfer = {
      transactionHash: sent.transactionHash,
      logIndex: sent.logIndex,
      observedBlockNumber: sent.blockNumber.toString(),
      observedBlockHash: sent.blockHash,
    };
    transfers.set(invoiceId, transfer);
  } else {
    if (!transfer) throw new DemoConflict("demo_transfer_required");
    if (step === "confirm") {
      requireStatus(invoice, "confirming");
      await anvil.mine(3);
    } else if (step === "settle") {
      requireStatus(invoice, "provisionally_paid");
      anvil.setFinality("safe");
    } else if (step === "finalize") {
      requireStatus(invoice, "settled");
      anvil.setFinality("finalized");
    }
  }
  if (!transfer) throw new Error("demo_transfer_missing");

  const response = await checkoutRequest(
    checkoutHandler,
    requestUrl,
    `/api/v1/invoices/${encodeURIComponent(invoiceId)}/claims`,
    {
      method: "POST",
      body: {
        transactionHash: transfer.transactionHash,
        logIndex: transfer.logIndex,
        observedBlockNumber: transfer.observedBlockNumber,
        observedBlockHash: transfer.observedBlockHash,
      },
    },
  );
  const result = await response.json() as Record<string, unknown>;
  return json({ ...result, transactionHash: transfer.transactionHash }, {
    status: response.status,
  });
}

async function demoInvoice(services: CheckoutServices, invoiceId: string): Promise<InvoiceRecord> {
  const invoice = await services.payment.getInvoiceRecord(invoiceId);
  if (invoice.merchant !== DEMO_MERCHANT_ID || invoice.productId !== DEMO_PRODUCT_ID) {
    throw new DemoConflict("demo_invoice_not_found");
  }
  return invoice;
}

function requireStatus(invoice: InvoiceRecord, status: InvoiceJson["status"]): void {
  if (invoice.status !== status) {
    throw new DemoConflict(`demo_step_requires_${status}`);
  }
}

async function checkoutRequest(
  checkoutHandler: (request: Request) => Promise<Response>,
  incomingUrl: string,
  pathname: string,
  init: { method: string; headers?: HeadersInit; body: Record<string, unknown> },
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  const request = new Request(new URL(pathname, incomingUrl), {
    method: init.method,
    headers,
    body: JSON.stringify(init.body),
  });
  return await checkoutHandler(withPeerAddress(request, "127.0.0.1"));
}

async function cloneJsonResponse(response: Response): Promise<Response> {
  return json(await response.json(), { status: response.status });
}

async function demoStatic(method: string, pathname: string): Promise<Response | null> {
  const file = pathname === "/" || pathname === "/index.html"
    ? ["index.html", "text/html; charset=utf-8"]
    : pathname === "/styles.css"
    ? ["styles.css", "text/css; charset=utf-8"]
    : pathname === "/app.js"
    ? ["app.js", "text/javascript; charset=utf-8"]
    : null;
  if (!file) return null;
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": file[1],
    "content-security-policy":
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; " +
      "img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  if (method === "HEAD") return new Response(null, { headers });
  return new Response(await Deno.readFile(new URL(file[0], STATIC_ROOT)), { headers });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

class DemoConflict extends Error {}
