"use strict";

const chat = document.getElementById("chat");
const welcome = document.getElementById("welcome");
const examples = document.getElementById("examples");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendButton = document.getElementById("send");
const newChatButton = document.getElementById("new-chat");

let conversationId = null;
let busy = false;

// ---------- Markdown mínimo y seguro (escapa el HTML antes de dar formato) ----------

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
}

function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function renderMarkdown(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    // Tabla: fila de cabecera seguida de una fila separadora |---|:---:|
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : "left"));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const cell = (tag, text, idx) => `<${tag} style="text-align:${aligns[idx] || "left"}">${inline(text)}</${tag}>`;
      html.push(
        "<table><thead><tr>" + header.map((h, idx) => cell("th", h, idx)).join("") + "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + r.map((c, idx) => cell("td", c, idx)).join("") + "</tr>").join("") +
        "</tbody></table>"
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      html.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      i++;
      continue;
    }

    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`);
        i++;
      }
      html.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s)/.test(lines[i]) && !lines[i].includes("|")) {
      paragraph.push(inline(lines[i++]));
    }
    if (paragraph.length === 0) paragraph.push(inline(lines[i++]));
    html.push(`<p>${paragraph.join("<br>")}</p>`);
  }
  return html.join("");
}

// ---------- Interfaz ----------

function scrollToBottom() {
  chat.scrollTop = chat.scrollHeight;
}

function addMessage(role) {
  welcome.hidden = true;
  const wrapper = document.createElement("div");
  wrapper.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  wrapper.appendChild(bubble);
  chat.appendChild(wrapper);
  return bubble;
}

function setBusy(value) {
  busy = value;
  sendButton.disabled = value;
  input.disabled = value;
  examples.querySelectorAll("button").forEach((b) => (b.disabled = value));
  if (!value) input.focus();
}

function autosize() {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
  input.style.overflowY = input.scrollHeight > 180 ? "auto" : "hidden";
}

async function ask(question) {
  if (busy || !question.trim()) return;
  setBusy(true);

  addMessage("user").textContent = question;
  const bubble = addMessage("assistant");
  const tools = document.createElement("div");
  tools.className = "tools";
  const body = document.createElement("div");
  body.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
  bubble.append(tools, body);
  scrollToBottom();

  let text = "";
  const toolNodes = new Map();

  const handlers = {
    meta: (data) => { conversationId = data.conversation_id; },
    delta: (data) => {
      text += data.text;
      body.innerHTML = renderMarkdown(text);
      scrollToBottom();
    },
    tool: (data) => {
      const details = document.createElement("details");
      details.className = "tool";
      details.innerHTML = "<summary>Consultando la base de datos…</summary><pre></pre>";
      details.querySelector("pre").textContent = data.sql;
      tools.appendChild(details);
      toolNodes.set(data.id, details);
      scrollToBottom();
    },
    tool_done: (data) => {
      const details = toolNodes.get(data.id);
      if (!details) return;
      details.querySelector("summary").textContent = data.ok ? "Consulta SQL ejecutada" : "La consulta SQL falló";
      if (!data.ok) details.classList.add("failed");
    },
    error: (data) => { throw new Error(data.message); },
    done: () => {},
  };

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question, conversation_id: conversationId }),
    });
    if (!response.ok || !response.body) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.detail || `Error HTTP ${response.status}`);
    }

    // Lee el flujo SSE: bloques separados por línea en blanco con "event:" y "data:".
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (handlers[event]) handlers[event](data ? JSON.parse(data) : {});
      }
    }
    if (!text) body.innerHTML = "<p><em>El agente terminó sin responder.</em></p>";
  } catch (err) {
    if (!text) body.innerHTML = "";
    const error = document.createElement("p");
    error.className = "error";
    error.textContent = `⚠️ ${err.message}`;
    body.appendChild(error);
  } finally {
    setBusy(false);
    scrollToBottom();
  }
}

async function newConversation() {
  if (busy) return;
  if (conversationId) {
    fetch(`/api/conversations/${conversationId}`, { method: "DELETE" }).catch(() => {});
  }
  conversationId = null;
  chat.querySelectorAll(".msg").forEach((node) => node.remove());
  welcome.hidden = false;
  input.focus();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = input.value;
  input.value = "";
  autosize();
  ask(question);
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});
input.addEventListener("input", autosize);
newChatButton.addEventListener("click", newConversation);

fetch("/api/config")
  .then((r) => r.json())
  .then((config) => {
    document.getElementById("model").textContent = config.model;
    for (const question of config.examples) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = question;
      button.addEventListener("click", () => ask(question));
      examples.appendChild(button);
    }
  })
  .catch(() => { document.getElementById("model").textContent = "sin conexión con el servidor"; });

input.focus();
