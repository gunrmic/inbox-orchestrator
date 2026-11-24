// Menu bar window. Talks only to the local daemon (through the preload bridge) and to the
// app's main process for starting and stopping the agent.
const $ = (s) => document.querySelector(s);
let tab = "waiting";
let projects = [];

const RISK = {
  0: "Runs on its own",
  1: "Runs on its own",
  2: "Visible to others",
  3: "Needs your OK",
};

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

function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function setStatus(tone, text) {
  $("#status").dataset.tone = tone;
  $("#status-text").textContent = text;
}

function showView(view) {
  $("#waiting").hidden = view !== "waiting";
  $("#activity").hidden = view !== "activity";
  $("#stopped").hidden = view !== "stopped";
  document.querySelector(".tabs").hidden = view === "stopped";
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
function renderAssign(node, a, assign) {
  node.querySelector(".assign").hidden = false;
  node.querySelector(".buttons .approve").hidden = true;
  node.querySelector(".args-wrap").hidden = true;
  const who = assign.scope === "domain" ? assign.domain : assign.sender;
  node.querySelector(".who").textContent = who;
  node.querySelector(".summary").textContent = `Which project is ${who}?`;
  const risk = node.querySelector(".risk");
  risk.textContent = "Question";
  risk.dataset.kind = "question";
  node.querySelector(".project").textContent = "New sender";
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
    else banner(`Saved: mail from ${who} now goes to ${res.projectId}.`);
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

async function renderCards() {
  const pending = await window.ibo.call("/actions?status=pending");
  $("#tab-waiting").textContent = pending.length ? `Waiting · ${pending.length}` : "Waiting";
  const root = $("#cards");
  root.innerHTML = "";
  if (pending.length === 0) {
    root.innerHTML = '<div class="empty"><strong>Nothing waiting for you.</strong><span>New mail that needs your OK shows up here.</span></div>';
    return;
  }
  for (const a of pending) {
    const node = $("#card").content.cloneNode(true);
    const card = node.querySelector(".card");
    card.dataset.level = a.risk;
    const risk = node.querySelector(".risk");
    risk.textContent = RISK[a.risk] ?? `Level ${a.risk}`;
    risk.dataset.level = a.risk;
    node.querySelector(".project").textContent = a.projectId ? `${a.projectId} · ${a.action.replace(/_/g, " ")}` : a.action.replace(/_/g, " ");
    node.querySelector(".summary").textContent = a.summary;
    const email = node.querySelector(".email");
    if (a.email) {
      email.textContent = `${a.email.from.replace(/<.*>/, "").trim()} · “${a.email.subject}”`;
      email.onclick = () => window.ibo.open(`https://mail.google.com/mail/u/0/#all/${a.email.threadId}`);
    } else email.hidden = true;
    node.querySelector(".reason").textContent = a.reason;
    const { _assign: assign, ...args } = a.args || {};
    if (assign) renderAssign(node, a, assign);
    const ta = node.querySelector(".args");
    ta.value = JSON.stringify(args, null, 2);
    if (a.risk === 3) node.querySelector(".approve").textContent = "Review and do it";
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

async function renderActivity() {
  const items = await window.ibo.call("/activity");
  const root = $("#activity");
  root.innerHTML = "";
  if (items.length === 0) {
    root.innerHTML = '<div class="empty"><strong>No activity yet.</strong><span>Every email the agent reads shows up here.</span></div>';
    return;
  }
  let day = "";
  for (const it of items) {
    const d = new Date(it.at);
    const label = d.toDateString() === new Date().toDateString() ? "Today" : d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
    if (label !== day) {
      day = label;
      const h = document.createElement("div");
      h.className = "day";
      h.textContent = label;
      root.appendChild(h);
    }
    const row = document.createElement("div");
    row.className = "event";
    row.dataset.tone = it.tone;
    const time = document.createElement("time");
    time.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const dot = document.createElement("span");
    dot.className = "dot";
    const text = document.createElement("div");
    text.className = "text";
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = it.title;
    text.appendChild(t);
    if (it.detail) {
      const dd = document.createElement("span");
      dd.className = "d";
      dd.textContent = it.detail;
      text.appendChild(dd);
    }
    row.append(time, dot, text);
    root.appendChild(row);
  }
}

async function renderStopped() {
  const agent = await window.ibo.agent();
  setStatus("warn", "Agent stopped · new mail is not being read");
  showView("stopped");
  $("#stop").hidden = true;
  $("#start").hidden = !agent.canStart;
  $("#autostart").checked = agent.autoStart;
  $("#autostart").parentElement.hidden = !agent.canStart;
  $("#stopped-text").textContent = agent.canStart
    ? "It reads new mail and prepares the work. Nothing is lost while it is off: when it starts, it picks up where it stopped."
    : "This copy of the app has no agent inside. Start it from the terminal with: ibo start";
  const failed = agent.lastExit && agent.lastExit.code;
  $("#show-log").hidden = !agent.log;
  $("#show-log").textContent = failed ? "It stopped with an error. Show the log" : "Show the log";
  $("#log").textContent = agent.log;
}

async function render() {
  let status;
  try {
    status = await window.ibo.call("/status");
  } catch {
    return renderStopped();
  }
  projects = status.projects;
  $("#kill").checked = status.killSwitch;
  const agent = window.ibo.agent ? await window.ibo.agent() : { startedByApp: false };
  $("#stop").hidden = !agent.startedByApp;
  if (status.killSwitch) setStatus("warn", "Paused · nothing runs, everything becomes a card");
  else if (status.agent === "waiting-setup") setStatus("warn", "Not connected to Gmail yet · finish setup");
  else setStatus("ok", `Watching Gmail · checked ${ago(status.lastPoll)} · ${projects.length} project${projects.length === 1 ? "" : "s"}`);
  if ($("#stopped").hidden === false) showView(tab);
  const up = window.ibo.update ? await window.ibo.update() : null;
  if (up && up.ready && $("#banner").hidden) banner(`Version ${up.ready} is ready.`, [["Restart to update", () => window.ibo.installUpdate()]]);
  await renderSuggestions(status);
  if (tab === "waiting") await renderCards();
  else await renderActivity();
}

function selectTab(next) {
  tab = next;
  $("#tab-waiting").setAttribute("aria-selected", String(next === "waiting"));
  $("#tab-activity").setAttribute("aria-selected", String(next === "activity"));
  showView(next);
  render();
}
$("#tab-waiting").onclick = () => selectTab("waiting");
$("#tab-activity").onclick = () => selectTab("activity");

$("#kill").onchange = async (e) => {
  await window.ibo.call("/killswitch", "POST", { on: e.target.checked });
  render();
};
$("#start").onclick = async () => {
  $("#start").disabled = true;
  $("#start").lastChild.textContent = "Starting…";
  await window.ibo.startAgent();
  $("#start").disabled = false;
  $("#start").lastChild.textContent = "Start the agent";
  render();
};
$("#stop").onclick = async () => {
  await window.ibo.stopAgent();
  setTimeout(render, 600);
};
$("#autostart").onchange = (e) => window.ibo.setAutoStart(e.target.checked);
$("#show-log").onclick = () => {
  $("#log").hidden = !$("#log").hidden;
};
$("#settings").onclick = () => window.ibo.openSetup();
$("#quit").onclick = () => window.ibo.quit();

showView("waiting");
render();
setInterval(render, 5_000);
