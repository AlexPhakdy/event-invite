const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = "guests";
const STATUSES = ["going", "maybe", "declined"];
const EVENT_KEYS = ["day", "dinner", "night"];

async function redis(command) {
  const res = await fetch(`${UPSTASH_URL}/${command.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Redis command failed: ${res.status}`);
  const data = await res.json();
  return data.result;
}

export default async function handler(req, res) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    // TEMPORARY diagnostic — reports presence/length only, never the actual secret values.
    res.status(500).json({
      error: "Storage isn't configured — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in the Vercel project's environment variables.",
      debug: {
        urlPresent: Boolean(UPSTASH_URL),
        urlLength: UPSTASH_URL ? UPSTASH_URL.length : 0,
        tokenPresent: Boolean(UPSTASH_TOKEN),
        tokenLength: UPSTASH_TOKEN ? UPSTASH_TOKEN.length : 0,
      },
    });
    return;
  }

  try {
    if (req.method === "GET") {
      const raw = await redis(["LRANGE", KEY, "0", "-1"]);
      const guests = (raw || []).map((s) => JSON.parse(s)).reverse();
      res.status(200).json(guests);
      return;
    }

    if (req.method === "POST") {
      const body = typeof req.body === "object" && req.body ? req.body : JSON.parse(req.body || "{}");
      const name = String(body.name || "").trim().slice(0, 60);
      if (!name) {
        res.status(400).json({ error: "Name is required" });
        return;
      }
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name,
        status: STATUSES.includes(body.status) ? body.status : "going",
        attending: Array.isArray(body.attending) ? body.attending.filter((k) => EVENT_KEYS.includes(k)) : [],
        note: String(body.note || "").trim().slice(0, 200),
        ts: Date.now(),
      };
      await redis(["LPUSH", KEY, JSON.stringify(entry)]);
      res.status(200).json(entry);
      return;
    }

    if (req.method === "DELETE") {
      await redis(["DEL", KEY]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: "Storage request failed" });
  }
}
