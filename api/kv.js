// Tiny shared key-value store backing the hosted game.
//
// The LAN server keeps game state in a long-lived process. Serverless has no
// such process, so state lives here instead and every client polls it. Kept
// deliberately dumb: the clients hold all the game logic.
//
// State is in-memory, so a cold start or a scale-out drops the room. Fine for
// a party (short sessions, constant traffic keeps the instance warm), and
// rejoining under the same name puts you back. For anything you actually care
// about, run the LAN server.

const store = (globalThis.__unhingedKV ||= new Map());

const SIX_HOURS = 6 * 60 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [k, rec] of store) if (now - rec.t > SIX_HOURS) store.delete(k);
}

module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const { key, value } = body;
      if (!key || typeof key !== "string") return res.status(400).json({ error: "key required" });
      if (String(value).length > 20000) return res.status(413).json({ error: "too big" });
      if (store.size > 5000) sweep();
      store.set(key, { v: String(value), t: Date.now() });
      return res.status(200).json({ ok: true });
    }

    const op = req.query.op;

    // One request returns every key in the room, so a poll is a single
    // round trip instead of a dozen.
    if (op === "dump") {
      const prefix = req.query.prefix;
      if (!prefix) return res.status(400).json({ error: "prefix required" });
      const out = {};
      for (const [k, rec] of store) if (k.startsWith(prefix)) out[k] = rec.v;
      return res.status(200).json({ data: out });
    }

    if (op === "get") {
      const rec = store.get(req.query.key);
      return res.status(200).json({ value: rec ? rec.v : null });
    }

    return res.status(400).json({ error: "unknown op" });
  } catch (err) {
    return res.status(500).json({ error: String(err && err.message) });
  }
};
