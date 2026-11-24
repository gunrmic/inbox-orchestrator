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
    const ta = node.querySelector(".args");
    ta.value = JSON.stringify(a.args, null, 2);
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
