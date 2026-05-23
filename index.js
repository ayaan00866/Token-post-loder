// ═══════════════════════════════════════════════════════════
//  FB TOKEN COMMENTER — Server
//  Uses Facebook Graph API with access tokens
//  npm install && node server.js
// ═══════════════════════════════════════════════════════════

const express = require("express");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Task Store ──────────────────────────────────────────────
const tasks = {}; // taskId -> task object

function makeId() { return crypto.randomBytes(5).toString("hex"); }

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ─── Graph API Comment ────────────────────────────────────────
function postComment(token, postId, message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ message });
    const url = `/v19.0/${postId}/comments?access_token=${encodeURIComponent(token)}`;
    const req = https.request({
      hostname: "graph.facebook.com",
      path: url,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.id) resolve(json.id);
          else reject(new Error(json.error?.message || "Failed"));
        } catch { reject(new Error("Parse error")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Comment Loop ─────────────────────────────────────────────
async function runTask(task) {
  task.status = "running";
  task.log.push({ t: Date.now(), msg: "▶ Task started" });

  let commentIdx = 0;
  let tokenIdx = 0;

  while (task.status === "running") {
    const token = task.mode === "multi"
      ? task.tokens[tokenIdx % task.tokens.length]
      : task.tokens[0];

    const rawComment = task.comments[commentIdx % task.comments.length];
    const message = task.prefix ? `${task.prefix}${rawComment}` : rawComment;

    try {
      const cid = await postComment(token, task.postId, message);
      task.sent++;
      task.log.unshift({ t: Date.now(), msg: `✅ Sent: "${message.substring(0, 50)}" → ID: ${cid}` });
    } catch (e) {
      task.errors++;
      task.log.unshift({ t: Date.now(), msg: `❌ Error [Token ${tokenIdx + 1}]: ${e.message}` });
    }

    if (task.log.length > 100) task.log = task.log.slice(0, 100);

    commentIdx++;
    if (task.mode === "multi") tokenIdx++;

    await new Promise(r => setTimeout(r, task.delay * 1000));
  }

  task.log.unshift({ t: Date.now(), msg: "⏹ Task stopped" });
}

// ─── API Routes ───────────────────────────────────────────────
app.post("/api/start", (req, res) => {
  const { tokens, postId, prefix, delay, comments, mode } = req.body;

  if (!tokens?.length)   return res.status(400).json({ error: "At least one token required" });
  if (!postId)           return res.status(400).json({ error: "Post UID required" });
  if (!comments?.length) return res.status(400).json({ error: "Comments list required" });

  const id = makeId();
  const task = {
    id,
    tokens: Array.isArray(tokens) ? tokens : [tokens],
    postId,
    prefix:   prefix || "",
    delay:    Math.max(1, parseInt(delay) || 5),
    comments: Array.isArray(comments) ? comments : [comments],
    mode:     mode || "multi",
    status:   "starting",
    sent:     0,
    errors:   0,
    startedAt: Date.now(),
    log:      [],
  };
  tasks[id] = task;
  runTask(task).catch(() => { task.status = "error"; });
  res.json({ taskId: id, message: "Task started" });
});

app.post("/api/stop", (req, res) => {
  const { taskId } = req.body;
  const task = tasks[taskId];
  if (!task) return res.status(404).json({ error: "Task not found" });
  task.status = "stopped";
  res.json({ message: "Task stopped" });
});

app.delete("/api/task/:id", (req, res) => {
  const task = tasks[req.params.id];
  if (!task) return res.status(404).json({ error: "Not found" });
  task.status = "stopped";
  delete tasks[req.params.id];
  res.json({ success: true });
});

app.get("/api/status", (req, res) => {
  const list = Object.values(tasks).map(t => ({
    id:        t.id,
    postId:    t.postId,
    mode:      t.mode,
    status:    t.status,
    sent:      t.sent,
    errors:    t.errors,
    tokens:    t.tokens.length,
    delay:     t.delay,
    prefix:    t.prefix,
    uptime:    fmtUptime(Date.now() - t.startedAt),
    log:       t.log.slice(0, 20),
  }));
  res.json({
    totalTasks:  list.length,
    running:     list.filter(t => t.status === "running").length,
    totalSent:   list.reduce((a, t) => a + t.sent, 0),
    totalErrors: list.reduce((a, t) => a + t.errors, 0),
    tasks:       list,
  });
});

app.get("*", (req, res) =>
  res.sendFile(path.join(__dirname, "public/index.html"))
);

app.listen(PORT, () =>
  console.log(`🚀 FB Token Commenter running → http://localhost:${PORT}`)
);
