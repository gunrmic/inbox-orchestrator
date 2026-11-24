// First-run setup window. Talks only to the local daemon through the preload bridge.
const $ = (s) => document.querySelector(s);
const STEPS = ["google", "claude", "model", "projects", "done"];
let current = null;
let timer = null;

function show(step) {
  current = step;
  for (const s of STEPS) $(`#${s}`).hidden = s !== step;
  const i = STEPS.indexOf(step);
  document.querySelectorAll("#steps li").forEach((li, j) => {
    li.classList.toggle("active", j === i);
    li.classList.toggle("complete", j < i);
  });
  if (step === "claude") claudeStep();
  if (step === "model") modelStep();
  if (step === "projects") projectsStep();
}

const status = () => window.ibo.call("/setup/status");
const err = (id, text) => {
  $(id).hidden = !text;
  $(id).textContent = text || "";
};
function poll(fn, ms = 1500) {
  clearInterval(timer);
  timer = setInterval(fn, ms);
}

// ---- 1. Google
$("#google-btn").onclick = async () => {
  err("#google-error", "");
  $("#google-btn").disabled = true;
  const res = await window.ibo.call("/setup/google", "POST");
  if (res.url) $("#google-link").onclick = (e) => (e.preventDefault(), window.ibo.open(res.url));
  $("#google-wait").hidden = false;
  poll(async () => {
    const s = await status();
    if (s.google.connected) {
      clearInterval(timer);
      show("claude");
    } else if (s.google.state === "error") {
      clearInterval(timer);
      $("#google-btn").disabled = false;
      $("#google-wait").hidden = true;
      err("#google-error", `Sign-in did not finish: ${s.google.error}`);
    }
  });
};

// ---- 2. Claude
async function claudeStep() {
  const s = await status();
  const route = s.claude.route;
  $("#claude-ok").hidden = !route;
  $("#claude-missing").hidden = !!route;
  $("#claude-ok").textContent = route === "api" ? "✓ Using your Anthropic API key" : route ? "✓ Using your Claude Code login. No API key needed." : "";
  $("#claude-next").textContent = route ? "Continue" : "Skip for now";
}
$("#claude-install").onclick = () => window.ibo.open("https://docs.claude.com/en/docs/claude-code/setup");
$("#claude-check").onclick = claudeStep;
$("#claude-key-save").onclick = async () => {
  const res = await window.ibo.call("/setup/claude-key", "POST", { key: $("#claude-key").value });
  err("#claude-error", res.error);
  if (!res.error) claudeStep();
};
$("#claude-next").onclick = () => show("model");

// ---- 3. Local model
function renderModel(m) {
  const busy = m.state === "running";
  $("#model-blocked").hidden = m.allowed;
  $("#model-ok").hidden = !(m.allowed && m.ready);
  $("#model-ok").textContent = `✓ ${m.name} is ready`;
  $("#model-actions").hidden = !m.allowed || m.ready || busy;
  $("#model-install").textContent = m.installed || m.brew ? `Install and download ${m.name} (recommended)` : "Get Ollama";
  $("#model-progress").hidden = !busy;
  $("#model-step").textContent = m.step || "";
  $("#model-bar").value = m.progress || 0;
  $("#model-next").hidden = busy || (m.allowed && !m.ready && m.state !== "error");
  err("#model-error", m.state === "error" ? m.error : "");
}
async function modelStep() {
  const s = await status();
  renderModel(s.model);
  if (s.model.state === "running") watchModel();
}
function watchModel() {
  poll(async () => {
    const m = (await status()).model;
    renderModel(m);
    if (m.state !== "running") clearInterval(timer);
  }, 1000);
}
$("#model-install").onclick = async () => {
  const s = await status();
  if (!s.model.installed && !s.model.brew) return window.ibo.open("https://ollama.com/download");
  await window.ibo.call("/setup/model", "POST");
  watchModel();
};
$("#model-skip").onclick = () => show("projects");
$("#model-next").onclick = () => show("projects");

// ---- 4. Projects
let started = false;
async function projectsStep() {
  if (started) return;
  const exports = await window.ibo.call("/setup/exports");
  $("#exports").hidden = exports.length === 0;
  $("#export-list").innerHTML = "";
  for (const e of exports) {
    const l = document.createElement("label");
    l.className = "row";
    l.innerHTML = '<input type="checkbox" checked /> <span></span>';
    l.querySelector("span").textContent = e.name;
    l.querySelector("input").value = e.path;
    $("#export-list").appendChild(l);
  }
}
$("#scan-btn").onclick = async () => {
  started = true;
  $("#scan-btn").disabled = true;
  $("#exports").hidden = true;
  const imports = [...document.querySelectorAll("#export-list input:checked")].map((i) => i.value);
  await window.ibo.call("/setup/discover", "POST", { imports });
  $("#scan-log").hidden = false;
  poll(async () => {
    const d = (await status()).discover;
    $("#scan-log").textContent = d.log.join("\n");
    if (d.state === "done") {
      clearInterval(timer);
      renderCandidates();
    } else if (d.state === "error") {
      clearInterval(timer);
      $("#scan-btn").disabled = false;
      err("#scan-error", d.error);
    }
  });
};

function card(c, checked) {
  const node = $("#card").content.cloneNode(true);
  const el = node.querySelector(".card");
  el.dataset.id = c.id;
  node.querySelector(".pick").checked = checked;
  node.querySelector(".name").textContent = c.name;
  const badge = node.querySelector(".badge");
  badge.textContent = c.status;
  badge.dataset.status = c.status;
  for (const e of c.evidence.slice(0, 3)) {
    const li = document.createElement("li");
    li.textContent = e;
    node.querySelector(".evidence").appendChild(li);
  }
  node.querySelector(".actions").textContent = c.actions.length ? `Can do: ${c.actions.join(", ")}` : "";
  node.querySelector(".domains").value = c.domains.join(", ");
  return node;
}
async function renderCandidates() {
  const { active, inactive } = await window.ibo.call("/setup/candidates");
  $("#scan").hidden = true;
  $("#found").hidden = false;
  $("#cards").innerHTML = "";
  if (active.length === 0) $("#cards").innerHTML = '<p class="muted">No active projects found. Add them by hand below.</p>';
  for (const c of active) $("#cards").appendChild(card(c, c.recommended === "add"));
  $("#older").hidden = inactive.length === 0;
  for (const c of inactive) $("#older-cards").appendChild(card(c, false));
}
$("#manual-add").onclick = () => $("#manual").appendChild($("#manual-row").content.cloneNode(true));

const list = (v) => v.split(",").map((x) => x.trim()).filter(Boolean);
$("#projects-save").onclick = async () => {
  const picks = [...document.querySelectorAll(".card[data-id]")]
    .filter((el) => el.querySelector(".pick").checked)
    .map((el) => ({ id: el.dataset.id, domains: list(el.querySelector(".domains").value) }));
  const manual = [...document.querySelectorAll(".manual-row")].map((el) => ({ name: el.querySelector(".m-name").value, domains: list(el.querySelector(".m-domains").value) }));
  const res = await window.ibo.call("/setup/projects", "POST", { picks, manual });
  if (res.error) return err("#scan-error", res.error);
  $("#done-summary").textContent = `${res.projects} project${res.projects === 1 ? "" : "s"} mapped.`;
  show("done");
};

// ---- 5. Done
$("#finish").onclick = async () => {
  await window.ibo.call("/setup/finish", "POST");
  window.ibo.closeSetup();
};

// Resume where the user left off (Google done already, for example).
(async () => {
  const s = await status();
  show(s.google.connected ? (s.projects > 0 ? "done" : "claude") : "google");
})();
