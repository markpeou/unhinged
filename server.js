// Unhinged — a local party game server.
// No dependencies. Run with: node server.js
//
// One laptop runs this. Everyone else opens the URL on their phone,
// on the same Wi-Fi. No internet required.

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { DECK, WHITE, PATTERN } = require("./prompts");

const PORT = Number(process.env.PORT) || 3000;
const HAND_SIZE = 7;

// ---------------------------------------------------------------- game state

const game = {
  phase: "lobby", // lobby | answer | vote | results
  players: [], // { id, name, drinks, sockets:Set }
  hostId: null,
  roundNum: 0,
  prompt: null, // { text, type, blanks? }
  answers: {}, // playerId -> { value }   value: playerId | string | [cards]
  entries: [], // [{ id, authorIds:[], parts:[{t,card}] }] — merged, shuffled
  votes: {}, // voterId -> entryId
  results: null,
  typeDecks: {},
  hands: {}, // playerId -> [card strings]
};

const clients = new Set(); // { playerId, res }

const uid = () => Math.random().toString(36).slice(2, 10);
const player = (id) => game.players.find((p) => p.id === id);
const connected = () => game.players.filter((p) => p.sockets.size > 0);

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Rounds follow PATTERN so "who here" prompts come up regularly instead of
// being buried in one big shuffle. Each type keeps its own pile.
function drawPrompt(roundNum) {
  const type = PATTERN[(roundNum - 1) % PATTERN.length];
  game.typeDecks = game.typeDecks || {};
  if (!game.typeDecks[type] || game.typeDecks[type].length === 0) {
    game.typeDecks[type] = shuffle(DECK.filter((d) => d.type === type));
  }
  return game.typeDecks[type].pop();
}

// {player} / {player2} become real names, chosen once when the round starts.
// Names are wrapped in sentinels so fillPrompt can tag them as people rather
// than cards — the substitution stays the single source of truth.
const NAME_OPEN = "\u0001";
const NAME_CLOSE = "\u0002";
const stripSentinels = (s) => s.split(NAME_OPEN).join("").split(NAME_CLOSE).join("");

// Person prompts are played from your hand exactly like black cards; only the
// wording differs. One helper so every branch treats them the same.
const isHandRound = (p) => p && (p.type === "hand" || p.play === "hand");

function resolvePrompt(prompt) {
  if (!prompt.text.includes("{player")) return prompt;
  const pool = connected().length ? connected() : game.players;
  const order = shuffle(pool);
  const first = order[0] ? order[0].name : "somebody";
  const second = order[1] ? order[1].name : first;
  const wrap = (n) => NAME_OPEN + n + NAME_CLOSE;
  return {
    ...prompt,
    text: prompt.text
      .replace(/\{player2\}/g, wrap(second))
      .replace(/\{player\}/g, wrap(first)),
  };
}

// Each hand is drawn independently rather than from one shared pile. That
// means two people can hold the same card — which is the only way the
// duplicate rule ever fires. A single 223-card pile would make it impossible.
function dealUp() {
  for (const p of game.players) {
    const hand = (game.hands[p.id] = game.hands[p.id] || []);
    let guard = 0;
    while (hand.length < HAND_SIZE && guard++ < 500) {
      const card = WHITE[Math.floor(Math.random() * WHITE.length)];
      if (!hand.includes(card)) hand.push(card); // no dupes within one hand
    }
  }
}

function ensureHost() {
  const live = connected();
  if (!live.some((p) => p.id === game.hostId)) {
    game.hostId = live.length ? live[0].id : null;
  }
}

// Slot the played cards into the blanks, tagging each fragment so the client
// can style player names and played cards differently.
function fillPrompt(text, cards) {
  const parts = [];
  const pending = [...cards];

  const pushBlanks = (chunk) => {
    let rest = chunk, m;
    while ((m = rest.match(/_{2,}/)) && pending.length) {
      if (m.index > 0) parts.push({ t: rest.slice(0, m.index), kind: "plain" });
      parts.push({ t: pending.shift(), kind: "card" });
      rest = rest.slice(m.index + m[0].length);
    }
    if (rest) parts.push({ t: rest, kind: "plain" });
  };

  // Odd segments are player names, thanks to the sentinels resolvePrompt adds.
  text.split(NAME_OPEN).forEach((seg, i) => {
    if (i === 0) return pushBlanks(seg);
    const [name, tail = ""] = seg.split(NAME_CLOSE);
    parts.push({ t: name, kind: "person" });
    pushBlanks(tail);
  });

  while (pending.length) parts.push({ t: " " + pending.shift(), kind: "card" });
  return parts;
}

// ------------------------------------------------------------------- rounds

function startRound() {
  game.roundNum += 1;
  game.prompt = resolvePrompt(drawPrompt(game.roundNum));
  game.answers = {};
  game.entries = [];
  game.votes = {};
  game.results = null;
  game.phase = "answer";
  if (isHandRound(game.prompt)) dealUp();
}

// Everyone still connected has acted, so move on without waiting.
function maybeAdvance() {
  const live = connected();
  if (live.length === 0) return;
  if (game.phase === "answer" && live.every((p) => game.answers[p.id])) closeAnswers();
  else if (game.phase === "vote" && live.every((p) => game.votes[p.id])) closeVotes();
}

function closeAnswers() {
  if (game.prompt.type === "pick") return tallyPicks();

  // Group identical submissions together. Two people playing the same card
  // is the whole point of the duplicate rule, so it has to merge.
  const groups = new Map();
  for (const [authorId, ans] of Object.entries(game.answers)) {
    const cards = Array.isArray(ans.value) ? ans.value : [ans.value];
    const key = cards.join(" | ").toLowerCase().trim();
    if (!groups.has(key)) {
      groups.set(key, {
        id: uid(),
        authorIds: [],
        parts:
          isHandRound(game.prompt)
            ? fillPrompt(game.prompt.text, cards)
            : [{ t: cards[0], kind: "card" }],
      });
    }
    groups.get(key).authorIds.push(authorId);
  }

  // Cards are spent whether or not the round resolves.
  if (isHandRound(game.prompt)) {
    for (const [authorId, ans] of Object.entries(game.answers)) {
      const hand = game.hands[authorId] || [];
      for (const card of ans.value) {
        const at = hand.indexOf(card);
        if (at >= 0) hand.splice(at, 1);
      }
    }
  }

  // Shuffle once, here. Reshuffling per broadcast would make the list jump
  // around under people's thumbs as others vote.
  game.entries = shuffle([...groups.values()]);
  if (game.entries.length < 2) return tallyEntries();
  game.phase = "vote";
}

function closeVotes() {
  tallyEntries();
}

function tallyPicks() {
  const counts = new Map();
  for (const [voterId, ans] of Object.entries(game.answers)) {
    if (!counts.has(ans.value)) counts.set(ans.value, []);
    counts.get(ans.value).push(voterId);
  }
  const rows = [...counts.entries()]
    .map(([targetId, voters]) => ({
      parts: [{ t: player(targetId)?.name || "Someone who left", kind: "person" }],
      targetIds: [targetId],
      count: voters.length,
      by: voters.map((id) => player(id)?.name || "?"),
    }))
    .sort((a, b) => b.count - a.count);

  finish(rows, "Most fingers pointed.", []);
}

function tallyEntries() {
  const rows = game.entries
    .map((e) => {
      const by = Object.entries(game.votes)
        .filter(([, entryId]) => entryId === e.id)
        .map(([voterId]) => player(voterId)?.name || "?");
      return {
        parts: e.parts,
        authors: e.authorIds.map((id) => player(id)?.name || "Someone who left"),
        targetIds: e.authorIds,
        count: by.length,
        by,
        duplicate: e.authorIds.length > 1,
      };
    })
    .sort((a, b) => b.count - a.count);

  // Playing the same card as somebody else costs you, votes or not.
  const clashed = [];
  for (const r of rows.filter((r) => r.duplicate)) {
    for (const id of r.targetIds) {
      const p = player(id);
      if (p) {
        p.drinks += 1;
        clashed.push(p.name);
      }
    }
  }

  finish(rows, "Most votes for the worst answer.", clashed);
}

function finish(rows, note, clashed) {
  const top = rows.length ? rows[0].count : 0;
  const sentenced = [];
  if (top > 0) {
    for (const r of rows.filter((r) => r.count === top)) {
      for (const id of r.targetIds) if (!sentenced.includes(id)) sentenced.push(id);
    }
  }
  for (const id of sentenced) {
    const p = player(id);
    if (p) p.drinks += 1;
  }
  game.results = {
    rows,
    note,
    clashed,
    sentenced: sentenced.map((id) => player(id)?.name).filter(Boolean),
  };
  game.phase = "results";
}

// -------------------------------------------------------------- per-player view

function viewFor(playerId) {
  const me = player(playerId);
  const live = connected();

  const base = {
    phase: game.phase,
    roundNum: game.roundNum,
    // Clean text for plain use, plus parts with player names already tagged.
    prompt: game.prompt
      ? {
          ...game.prompt,
          text: stripSentinels(game.prompt.text),
          parts: fillPrompt(game.prompt.text, []),
        }
      : null,
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      drinks: p.drinks,
      online: p.sockets.size > 0,
      isHost: p.id === game.hostId,
    })),
    you: me
      ? {
          id: me.id,
          name: me.name,
          drinks: me.drinks,
          isHost: me.id === game.hostId,
          submitted: Boolean(game.answers[me.id]),
          voted: Boolean(game.votes[me.id]),
          hand: game.hands[me.id] || [],
        }
      : null,
    waitingOn: [],
    entries: null,
    results: game.results,
  };

  if (game.phase === "answer") {
    base.waitingOn = live.filter((p) => !game.answers[p.id]).map((p) => p.name);
    if (me && game.answers[me.id]) {
      const v = game.answers[me.id].value;
      base.yourAnswer =
        game.prompt.type === "pick"
          ? player(v)?.name || "?"
          : Array.isArray(v)
            ? v.join(" + ")
            : v;
    }
  }

  if (game.phase === "vote") {
    base.waitingOn = live.filter((p) => !game.votes[p.id]).map((p) => p.name);
    base.entries = game.entries.map((e) => ({
      id: e.id,
      parts: e.parts,
      mine: e.authorIds.includes(playerId),
    }));
  }

  return base;
}

function broadcast() {
  ensureHost();
  for (const c of clients) {
    try {
      c.res.write(`data: ${JSON.stringify(viewFor(c.playerId))}\n\n`);
    } catch {
      clients.delete(c);
    }
  }
}

// -------------------------------------------------------------------- actions

function handleAction(body) {
  const { pid, type, payload } = body;
  const me = player(pid);
  if (!me) return { error: "unknown player" };
  const isHost = me.id === game.hostId;

  switch (type) {
    case "start":
      if (!isHost) break;
      if (connected().length < 2) return { error: "Need at least two people." };
      for (const p of game.players) p.drinks = 0;
      game.roundNum = 0;
      game.hands = {};
      game.typeDecks = {};
      startRound();
      break;

    case "next":
      if (!isHost) break;
      startRound();
      break;

    case "skip": // host force-closes the current phase
      if (!isHost) break;
      if (game.phase === "answer") closeAnswers();
      else if (game.phase === "vote") closeVotes();
      break;

    case "submit": {
      if (game.phase !== "answer") break;
      if (game.answers[me.id]) break;
      let value = payload;

      if (game.prompt.type === "pick") {
        if (!player(value)) return { error: "Pick someone who is here." };
      } else if (isHandRound(game.prompt)) {
        const need = game.prompt.blanks || 1;
        const hand = game.hands[me.id] || [];
        if (!Array.isArray(value) || value.length !== need) {
          return { error: `Play ${need} card${need > 1 ? "s" : ""}.` };
        }
        const spare = [...hand];
        for (const card of value) {
          const at = spare.indexOf(card);
          if (at < 0) return { error: "That card is not in your hand." };
          spare.splice(at, 1);
        }
      } else {
        value = String(value || "").trim().slice(0, 200);
        if (!value) return { error: "Write something." };
      }

      game.answers[me.id] = { value };
      maybeAdvance();
      break;
    }

    case "swap": {
      // One free hand reset per round, for when you've been dealt nothing.
      if (game.phase !== "answer" || !isHandRound(game.prompt)) break;
      if (game.answers[me.id]) break;
      game.hands[me.id] = [];
      dealUp();
      me.drinks += 1; // it costs you
      break;
    }

    case "vote": {
      if (game.phase !== "vote") break;
      if (game.votes[me.id]) break;
      const target = game.entries.find((e) => e.id === payload);
      if (!target) return { error: "That answer is gone." };
      if (target.authorIds.includes(me.id)) return { error: "No voting for yourself." };
      game.votes[me.id] = payload;
      maybeAdvance();
      break;
    }

    case "endGame":
      if (!isHost) break;
      game.phase = "lobby";
      game.prompt = null;
      game.results = null;
      break;

    case "kick": {
      if (!isHost) break;
      const target = player(payload);
      if (!target || target.id === me.id) break;
      game.players = game.players.filter((p) => p.id !== target.id);
      delete game.answers[target.id];
      delete game.votes[target.id];
      delete game.hands[target.id];
      for (const c of [...clients]) if (c.playerId === target.id) clients.delete(c);
      maybeAdvance();
      break;
    }
  }

  broadcast();
  return { ok: true };
}

// ---------------------------------------------------------------------- http

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}

const json = (res, code, obj) =>
  send(res, code, JSON.stringify(obj), { "Content-Type": "application/json" });

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e5) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // --- join / rejoin
  if (req.method === "POST" && url.pathname === "/api/join") {
    const { name, pid } = await readBody(req);

    const known = pid && player(pid);
    if (known) {
      broadcast();
      return json(res, 200, { pid: known.id, name: known.name });
    }

    const clean = String(name || "").trim().slice(0, 18);
    if (!clean) return json(res, 400, { error: "Enter a name." });

    // Same name, currently offline → reclaim that seat.
    const stale = game.players.find(
      (p) => p.name.toLowerCase() === clean.toLowerCase() && p.sockets.size === 0
    );
    if (stale) {
      broadcast();
      return json(res, 200, { pid: stale.id, name: stale.name });
    }

    if (game.players.some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
      return json(res, 409, { error: "That name is taken." });
    }

    const p = { id: uid(), name: clean, drinks: 0, sockets: new Set() };
    game.players.push(p);
    if (!game.hostId) game.hostId = p.id;
    if (game.phase !== "lobby") dealUp(); // latecomers get a hand
    broadcast();
    return json(res, 200, { pid: p.id, name: p.name });
  }

  // --- action
  if (req.method === "POST" && url.pathname === "/api/action") {
    const out = handleAction(await readBody(req));
    return json(res, out.error ? 400 : 200, out);
  }

  // --- live state stream
  if (url.pathname === "/api/events") {
    const pid = url.searchParams.get("pid");
    const me = player(pid);
    if (!me) return send(res, 404, "no such player");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 1500\n\n");

    const client = { playerId: pid, res };
    clients.add(client);
    me.sockets.add(client);
    ensureHost();

    const keepAlive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {}
    }, 20000);

    res.write(`data: ${JSON.stringify(viewFor(pid))}\n\n`);
    broadcast();

    req.on("close", () => {
      clearInterval(keepAlive);
      clients.delete(client);
      me.sockets.delete(client);
      setTimeout(() => {
        maybeAdvance();
        broadcast();
      }, 400);
    });
    return;
  }

  // --- static
  const file = url.pathname === "/" ? "/index.html" : url.pathname;
  const full = path.join(__dirname, "public", path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, "Not found");
    send(res, 200, data, {
      "Content-Type": MIME[path.extname(full)] || "application/octet-stream",
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal)
    .map((n) => n.address);

  console.log("\n  Unhinged is in session.\n");
  console.log(`  This machine:   http://localhost:${PORT}`);
  for (const ip of lan) console.log(`  Everyone else:  http://${ip}:${PORT}`);
  console.log("\n  Same Wi-Fi. First person to join is the host.\n");
});
