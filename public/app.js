const state = {
  session: null,
  overview: null,
};

const signInPanel = document.querySelector('[data-panel="signin"]');
const consolePanel = document.querySelector('[data-panel="console"]');
const sessionSummary = document.querySelector("[data-session-summary]");
const statusElement = document.querySelector("[data-status]");

document.querySelector("[data-logout]")?.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST", headers: mutationHeaders() });
  location.reload();
});

document.querySelectorAll("[data-chain-id]").forEach((card) => {
  card.querySelector('[name="treasuryAddress"]')?.addEventListener("change", () => saveChain(card));
  card.querySelector('[name="enabled"]')?.addEventListener("change", () => saveChain(card));
});

document.querySelector("[data-webhook-url]")?.addEventListener("change", saveMerchant);
document.querySelector("[data-create-key]")?.addEventListener("click", createMerchantKey);
document.querySelector("[data-copy-key]")?.addEventListener("click", async () => {
  const value = document.querySelector("[data-key-value]")?.textContent ?? "";
  await navigator.clipboard.writeText(value);
  setStatus("Merchant key copied.");
});

await refresh();

async function refresh() {
  const sessionResponse = await fetch("/api/v1/admin/session");
  state.session = sessionResponse.ok ? await sessionResponse.json() : { authenticated: false };
  const authenticated = state.session.authenticated === true;
  const role = state.session.member?.role ?? "guest";
  document.body.dataset.role = role;
  signInPanel.hidden = authenticated;
  consolePanel.hidden = !authenticated;
  sessionSummary.hidden = !authenticated;
  if (!authenticated) return;

  applyPermissions(role);

  document.querySelector("[data-session-handle]").textContent = state.session.member.handle;
  const response = await fetch("/api/v1/admin/overview");
  if (!response.ok) return setStatus(await errorText(response), "error");
  state.overview = await response.json();
  renderOverview();
}

function applyPermissions(role) {
  const canConfigure = role === "owner" || role === "admin";
  document.querySelectorAll("[data-chain-id] input, [data-webhook-url]").forEach((control) => {
    control.disabled = !canConfigure;
  });
  const keyButton = document.querySelector("[data-create-key]");
  if (keyButton) keyButton.hidden = role !== "owner";
}

function renderOverview() {
  const overview = state.overview ?? {};
  const health = document.querySelector("[data-health-state]");
  health.textContent = overview.health ?? "Ready";
  health.dataset.state = "ready";

  for (const [name, value] of Object.entries(overview.metrics ?? {})) {
    const element = document.querySelector(`[data-metric="${name}"]`);
    if (element) element.textContent = String(value);
  }

  for (const chain of overview.chains ?? []) {
    const card = document.querySelector(`[data-chain-id="${chain.chainId}"]`);
    if (!card) continue;
    card.querySelector('[name="treasuryAddress"]').value = chain.treasuryAddress ?? "";
    card.querySelector('[name="enabled"]').checked = chain.enabled === true;
  }

  if (overview.merchant?.settlementWebhookUrl) {
    document.querySelector("[data-webhook-url]").value = overview.merchant.settlementWebhookUrl;
  }
  renderKeys(overview.keys ?? []);
  renderInvoices(overview.invoices ?? []);
}

async function saveChain(card) {
  const chainId = Number(card.dataset.chainId);
  const body = {
    treasuryAddress: card.querySelector('[name="treasuryAddress"]').value.trim(),
    enabled: card.querySelector('[name="enabled"]').checked,
  };
  const response = await requestJson(`/api/v1/admin/chains/${chainId}`, "PUT", body);
  if (!response.ok) return setStatus(await errorText(response), "error");
  setStatus(`${card.querySelector("strong").textContent} configuration saved.`);
  await refresh();
}

async function saveMerchant() {
  const settlementWebhookUrl = document.querySelector("[data-webhook-url]").value.trim();
  const response = await requestJson(
    "/api/v1/admin/merchants/linkedin-scraper-2025",
    "PUT",
    { name: "LinkedIn Sales Agent", settlementWebhookUrl },
  );
  if (!response.ok) {
    setStatus(await errorText(response), "error");
    return false;
  }
  setStatus("Settlement webhook saved.");
  await refresh();
  return true;
}

async function createMerchantKey() {
  const button = document.querySelector("[data-create-key]");
  button.disabled = true;
  try {
    if (!(await saveMerchant())) return;
    const response = await requestJson("/api/v1/admin/merchant-keys", "POST", {
      merchantId: "linkedin-scraper-2025",
      label: `LinkedIn production ${new Date().toISOString().slice(0, 10)}`,
    });
    if (!response.ok) return setStatus(await errorText(response), "error");
    const body = await response.json();
    document.querySelector("[data-key-value]").textContent = body.token;
    document.querySelector("[data-key-reveal]").hidden = false;
    setStatus("Merchant key generated. It will not be shown again.");
    await refresh();
  } finally {
    button.disabled = false;
  }
}

function renderKeys(keys) {
  const root = document.querySelector("[data-key-list]");
  root.innerHTML = keys.length
    ? keys.map((key) => `
    <article data-key-id="${escapeHtml(key.id)}">
      <header>
        <div><strong>${escapeHtml(key.label)}</strong><p>${
      escapeHtml(key.scopes.join(" · "))
    }</p></div>
        <button type="button" aria-label="Revoke ${
      escapeHtml(key.label)
    }" title="Revoke key">×</button>
      </header>
      <small>Created ${formatDate(key.createdAt)}${
      key.lastUsedAt ? ` · used ${formatDate(key.lastUsedAt)}` : ""
    }</small>
    </article>
  `).join("")
    : "<p>No merchant keys yet.</p>";
  root.querySelectorAll("[data-key-id] button").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.closest("[data-key-id]").dataset.keyId;
      const response = await fetch(`/api/v1/admin/merchant-keys/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: mutationHeaders(),
      });
      if (!response.ok) return setStatus(await errorText(response), "error");
      setStatus("Merchant key revoked.");
      await refresh();
    });
  });
  if (document.body.dataset.role !== "owner") {
    root.querySelectorAll("button").forEach((button) => button.remove());
  }
}

function renderInvoices(invoices) {
  const root = document.querySelector("[data-invoice-list]");
  root.innerHTML = invoices.length
    ? invoices.map((invoice) => `
    <article>
      <header><strong>${escapeHtml(invoice.productId)}</strong><small>${
      escapeHtml(invoice.status)
    }</small></header>
      <p>${escapeHtml(invoice.paidAmountUnits)} USDC units · chain ${
      escapeHtml(invoice.chainId)
    }</p>
      <small>${formatDate(invoice.createdAt)} · ${escapeHtml(invoice.id)}</small>
    </article>
  `).join("")
    : "<p>No invoices yet.</p>";
}

async function requestJson(path, method, body) {
  return await fetch(path, {
    method,
    headers: { ...mutationHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mutationHeaders() {
  return { "x-uos-requested-with": "checkout-admin" };
}

async function errorText(response) {
  const body = await response.json().catch(() => ({}));
  return body.error ?? `${response.status}`;
}

function setStatus(message, stateName = "") {
  statusElement.textContent = message;
  if (stateName) statusElement.dataset.state = stateName;
  else delete statusElement.dataset.state;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown time";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
