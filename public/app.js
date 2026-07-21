const state = {
  mode: "register",
  session: null,
};

const statusEl = document.querySelector("[data-status]");
const authPanel = document.querySelector('[data-panel="auth"]');
const accountPanel = document.querySelector('[data-panel="account"]');
const adminPanel = document.querySelector('[data-panel="admin"]');
const authForm = document.querySelector("[data-auth-form]");
const agentTokenForm = document.querySelector("[data-agent-token-form]");
const tokenOutput = document.querySelector("[data-agent-token-output]");

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

authForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(authForm).entries());
  const path = state.mode === "login" ? "/api/auth/login" : "/api/auth/register";
  const response = await postJson(path, data);
  if (!response.ok) {
    return setStatus(await errorText(response), "error");
  }
  await refreshSession();
});

document.querySelector("[data-logout]")?.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  await refreshSession();
});

document.querySelector("[data-copy-referral]")?.addEventListener("click", async () => {
  const code = state.session?.user?.referralCode;
  if (!code) return;
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("ref", code);
  await navigator.clipboard?.writeText(url.toString());
  setStatus("Copied.");
});

agentTokenForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(agentTokenForm).entries());
  const response = await postJson("/api/admin/agent-tokens", data);
  if (!response.ok) {
    return setStatus(await errorText(response), "error");
  }
  const body = await response.json();
  tokenOutput.hidden = false;
  tokenOutput.textContent = body.token;
  await loadAdmin();
});

async function refreshSession() {
  const response = await fetch("/api/account/session");
  state.session = await response.json();
  render();
}

function render() {
  const authed = state.session?.authenticated === true;
  document.body.dataset.role = state.session?.user?.role ?? "guest";
  authPanel.hidden = authed;
  accountPanel.hidden = !authed;
  adminPanel.hidden = !authed || !["admin", "super_admin"].includes(state.session.user.role);

  if (!authed) {
    setMode(state.session?.setupRequired ? "register" : state.mode);
    setStatus(state.session?.setupRequired ? "Create the first account." : "");
    return;
  }

  document.querySelector("[data-account-name]").textContent = state.session.user.name;
  document.querySelector("[data-account-role]").textContent = state.session.user.role;
  document.querySelector("[data-account-referral]").textContent = state.session.user.referralCode;
  setStatus("");
  if (!adminPanel.hidden) {
    loadAdmin();
  }
}

async function loadAdmin() {
  const response = await fetch("/api/admin/users");
  if (!response.ok) return;
  const body = await response.json();
  const root = document.querySelector("[data-users]");
  root.innerHTML = body.users.map((user) => `
    <article data-user-id="${escapeHtml(user.id)}">
      <header>
        <strong>${escapeHtml(user.email)}</strong>
        <select data-role-select ${state.session.user.role !== "super_admin" ? "disabled" : ""}>
          ${
    ["user", "admin", "super_admin"].map((role) =>
      `<option value="${role}" ${user.role === role ? "selected" : ""}>${role}</option>`
    ).join("")
  }
        </select>
      </header>
      <p>${escapeHtml(user.name)} · ${escapeHtml(user.referralCode)}</p>
    </article>
  `).join("");

  root.querySelectorAll("[data-role-select]").forEach((select) => {
    select.addEventListener("change", async () => {
      const id = select.closest("[data-user-id]").dataset.userId;
      const response = await fetch(`/api/admin/users/${id}/role`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: select.value }),
      });
      if (!response.ok) setStatus(await errorText(response), "error");
      await refreshSession();
    });
  });
}

function setMode(mode) {
  state.mode = mode === "login" ? "login" : "register";
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.setAttribute("aria-current", button.dataset.mode === state.mode ? "true" : "false");
  });
  document.querySelector("[data-name-row]").hidden = state.mode === "login";
  document.querySelector("[data-ref-row]").hidden = state.mode === "login";
}

async function postJson(path, body) {
  return await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorText(response) {
  const body = await response.json().catch(() => ({}));
  return body.error || `${response.status}`;
}

function setStatus(message, stateName = "") {
  statusEl.textContent = message;
  if (stateName) statusEl.dataset.state = stateName;
  else delete statusEl.dataset.state;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const incomingRef = new URLSearchParams(window.location.search).get("ref");
if (incomingRef) {
  const input = document.querySelector('input[name="referralCode"]');
  if (input) input.value = incomingRef;
}

setMode("register");
refreshSession();
