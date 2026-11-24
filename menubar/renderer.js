const RISK = { 0: "read", 1: "local", 2: "visible to others", 3: "dangerous" };
const $ = (s) => document.querySelector(s);

function banner(text, actions = []) {
  const el = $("#banner");
  el.hidden = false;
  el.textContent = text;
  for (const [label, fn] of actions) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = async () => {
      await fn();
      el.hidden = true;
    };
    el.appendChild(b);
  }
}

async function act(id, kind, args) {
  const route = kind === "edit" ? `/actions/${id}/edit` : `/actions/${id}/${kind}`;
  const res = await window.ibo.call(route, "POST", kind === "edit" ? { args } : undefined);
  if (res.error) banner(res.error);
  else if (res.action && res.action.status === "failed") banner(`Failed: ${res.action.result}`);
  else if (res.offerPromotion) {
    const { projectId, action } = res.action;
    banner(`You approved "${action}" in ${projectId} many times in a row. Do it automatically from now on?`, [
      ["Yes, automatic", () => window.ibo.call("/promote", "POST", { projectId, action })],
      ["Keep asking", async () => {}],
    ]);
  }
  await render();
  window.ibo.refresh();
}

/** "Which project is this sender?" with the likeliest project first, then the rest, then "new". */
function renderAssign(node, a, assign, projects) {
  const box = node.querySelector(".assign");
  box.hidden = false;
  node.querySelector(".who").textContent = assign.scope === "domain" ? assign.domain : assign.sender;
  const select = node.querySelector(".assign-select");
  const order = [...assign.suggestions, ...projects.map((p) => p.id).filter((id) => !assign.suggestions.includes(id))];
  const options = [
    ...order.map((id, i) => [id, `${id}${i === 0 && assign.suggestions.length ? " (recommended)" : ""}`]),
    ["new", `New project: ${assign.newName}${assign.suggestions.length ? "" : " (recommended)"}`],
  ];
  if (!assign.suggestions.length) options.unshift(options.pop());
  for (const [value, label] of options) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    select.appendChild(o);
  }
  node.querySelector(".assign-btn").onclick = async () => {
    const res = await window.ibo.call(`/actions/${a.id}/assign`, "POST", { project: select.value });
    if (res.error) banner(res.error);
    else banner(`Saved: mail from ${assign.scope === "domain" ? assign.domain : assign.sender} now goes to ${res.projectId}.`);
    await render();
    window.ibo.refresh();
  };
}

/** Weekly discovery results: new projects, or projects that went quiet. */
async function renderSuggestions(status) {
  const box = $("#suggestions");
  if (!status.suggestions) {
    box.hidden = true;
    return;
  }
  const list = await window.ibo.call("/suggestions");
  box.hidden = list.length === 0;
  box.innerHTML = "<strong>Found while you worked</strong>";
  for (const s of list) {
    const row = document.createElement("div");
    row.className = "row";
    const text = document.createElement("span");
    text.textContent = s.text;
    text.title = s.evidence.join("\n");
    const yes = document.createElement("button");
    yes.textContent = s.kind === "new" ? "Add" : "Update";
    const no = document.createElement("button");
    no.textContent = "Ignore";
    const answer = (accept) => async () => {
      await window.ibo.call(`/suggestions/${encodeURIComponent(s.id)}`, "POST", { accept });
      render();
      window.ibo.refresh();
    };
    yes.onclick = answer(true);
    no.onclick = answer(false);
    row.append(text, yes, no);
    box.appendChild(row);
  }
}

async function render() {
  let status;
  try {
    status = await window.ibo.call("/status");
  } catch {
    $("#cards").innerHTML = '<p class="empty">The daemon is not running. Start it with <code>ibo start</code>.</p>';
    return;
  }
  $("#kill").checked = status.killSwitch;
  $("#footer").textContent = `Mode: ${status.mode} · ${status.projects.length} projects · last check ${status.lastPoll ? new Date(status.lastPoll).toLocaleTimeString() : "never"}`;

  await renderSuggestions(status);
  const pending = await window.ibo.call("/actions?status=pending");
  const root = $("#cards");
  root.innerHTML = "";
  if (pending.length === 0) {
    root.innerHTML = '<p class="empty">Nothing waiting for you.</p>';
    return;
  }
  for (const a of pending) {
    const node = $("#card").content.cloneNode(true);
    node.querySelector(".risk").textContent = `Level ${a.risk} · ${RISK[a.risk]}`;
    node.querySelector(".risk").dataset.level = a.risk;
    node.querySelector(".project").textContent = a.projectId ? `${a.projectId} / ${a.action}` : a.action;
    node.querySelector(".summary").textContent = a.summary;
    const email = node.querySelector(".email");
    if (a.email) {
      email.textContent = `${a.email.from}: ${a.email.subject}`;
      email.onclick = () => window.ibo.open(`https://mail.google.com/mail/u/0/#all/${a.email.threadId}`);
    }
    node.querySelector(".reason").textContent = a.reason;
    const { _assign: assign, ...args } = a.args || {};
    if (assign) renderAssign(node, a, assign, status.projects);
    const ta = node.querySelector(".args");
    ta.value = JSON.stringify(args, null, 2);
    node.querySelector(".approve").onclick = () => act(a.id, "approve");
    node.querySelector(".reject").onclick = () => act(a.id, "reject");
    node.querySelector(".edit").onclick = () => {
      try {
        act(a.id, "edit", JSON.parse(ta.value));
      } catch {
        banner("The details are not valid JSON.");
      }
    };
    root.appendChild(node);
  }
}

$("#kill").onchange = async (e) => {
  await window.ibo.call("/killswitch", "POST", { on: e.target.checked });
  render();
};

render();
setInterval(render, 10_000);
