const emptyPanel = document.querySelector("[data-empty]");
const invoicePanel = document.querySelector("[data-invoice]");
const createButton = document.querySelector("[data-create]");
const advanceButton = document.querySelector("[data-advance]");
const message = document.querySelector("[data-message]");
const transactionRow = document.querySelector("[data-transaction-row]");

const statusOrder = [
  "awaiting_payment",
  "confirming",
  "provisionally_paid",
  "settled",
  "finalized",
];

const presentation = {
  awaiting_payment: {
    action: "transfer",
    button: "Send exact USDC on Anvil",
    message: "Invoice created. No transaction has been sent.",
    loading: "Impersonating a funded holder and executing USDC.transfer…",
  },
  confirming: {
    action: "confirm",
    button: "Mine 3 confirmation blocks",
    message: "The real USDC Transfer log is included. Checkout is waiting for three later blocks.",
    loading: "Mining three local Base blocks and re-verifying the receipt…",
  },
  provisionally_paid: {
    action: "settle",
    button: "Advance to safe settlement",
    message: "Three blocks are sealed. Checkout has provisionally accepted the payment.",
    loading: "Advancing Anvil's simulated safe head…",
  },
  settled: {
    action: "finalize",
    button: "Advance to finalized",
    message: "The payment is behind the safe head and the settlement event has been signed.",
    loading: "Advancing Anvil's simulated finalized head…",
  },
  finalized: {
    action: null,
    button: "Start another invoice",
    message: "Complete. The exact USDC transfer is finalized in Checkout's lifecycle.",
    loading: "Creating another invoice…",
  },
};

let invoice = null;
let transactionHash = null;

createButton?.addEventListener("click", createInvoice);
advanceButton?.addEventListener("click", advance);
document.querySelector("[data-copy]")?.addEventListener("click", async () => {
  if (!invoice?.treasuryAddress) return;
  await navigator.clipboard.writeText(invoice.treasuryAddress);
  setMessage("Recipient address copied.");
});

async function createInvoice() {
  setBusy(true, "Creating an exact-amount invoice…");
  try {
    const response = await fetch("/api/demo/invoices", { method: "POST" });
    invoice = await responseJson(response);
    transactionHash = null;
    render();
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), "error");
  } finally {
    setBusy(false);
  }
}

async function advance() {
  if (!invoice) return;
  const view = presentation[invoice.status];
  if (!view) return setMessage(`Unsupported invoice status: ${invoice.status}`, "error");
  if (!view.action) return await createInvoice();
  setBusy(true, view.loading);
  try {
    const response = await fetch(
      `/api/demo/invoices/${encodeURIComponent(invoice.id)}/steps/${view.action}`,
      { method: "POST" },
    );
    const result = await responseJson(response);
    invoice = result.invoice;
    transactionHash = result.transactionHash ?? transactionHash;
    render();
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), "error");
  } finally {
    setBusy(false);
  }
}

function render() {
  if (!invoice) return;
  document.body.dataset.state = invoice.status;
  emptyPanel.hidden = true;
  invoicePanel.hidden = false;
  document.querySelector("[data-amount]").textContent = formatUnits(invoice.paidAmountUnits, 6);
  document.querySelector("[data-network]").textContent =
    `${invoice.networkName} · ${invoice.chainId}`;
  document.querySelector("[data-treasury]").textContent = invoice.treasuryAddress;
  transactionRow.hidden = !transactionHash;
  document.querySelector("[data-transaction]").textContent = transactionHash ?? "—";

  const currentIndex = statusOrder.indexOf(invoice.status);
  for (const item of document.querySelectorAll("[data-progress] li")) {
    const index = statusOrder.indexOf(item.dataset.status);
    item.dataset.complete = String(index >= 0 && index < currentIndex);
    if (index === currentIndex) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  }

  const view = presentation[invoice.status];
  advanceButton.textContent = view?.button ?? "Unavailable";
  advanceButton.disabled = !view;
  setMessage(view?.message ?? `Unsupported invoice status: ${invoice.status}`);
}

function setBusy(busy, textValue) {
  createButton.disabled = busy;
  advanceButton.disabled = busy;
  if (busy && textValue) setMessage(textValue);
}

function setMessage(value, tone = "normal") {
  message.textContent = value;
  message.dataset.tone = tone;
}

async function responseJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Demo request failed (${response.status}).`);
  return body;
}

function formatUnits(value, decimals) {
  const digits = String(value);
  const padded = digits.padStart(decimals + 1, "0");
  return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
}
