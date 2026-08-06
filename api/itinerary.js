const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_CODE = process.env.ADMIN_CODE;
const KEY = "itinerary";

async function redis(command) {
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Redis command failed: ${res.status}`);
  const data = await res.json();
  return data.result;
}

function checkCode(req, res) {
  const supplied = req.headers["x-admin-code"];
  if (!ADMIN_CODE || supplied !== ADMIN_CODE) {
    res.status(401).json({ error: "Wrong code" });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    res.status(500).json({
      error: "Storage isn't configured — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in the Vercel project's environment variables.",
    });
    return;
  }

  try {
    // itinerary is readable by everyone (it's just the schedule), but every write
    // requires the host code — same pattern as /api/guests
    if (req.method === "GET") {
      const raw = await redis(["LRANGE", KEY, "0", "-1"]);
      const items = (raw || []).map((s) => JSON.parse(s)).reverse();
      res.status(200).json(items);
      return;
    }

    if (req.method === "POST") {
      if (!checkCode(req, res)) return;

      const body = typeof req.body === "object" && req.body ? req.body : JSON.parse(req.body || "{}");
      const title = String(body.title || "").trim().slice(0, 60);
      if (!title) {
        res.status(400).json({ error: "Event name is required" });
        return;
      }
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title,
        time: String(body.time || "").trim().slice(0, 40),
        description: String(body.description || "").trim().slice(0, 300),
        ts: Date.now(),
      };
      await redis(["LPUSH", KEY, JSON.stringify(entry)]);
      res.status(200).json(entry);
      return;
    }

    // edits an entry in place (LSET at its index) so it keeps its position in the
    // timeline instead of jumping to the top
    if (req.method === "PATCH") {
      if (!checkCode(req, res)) return;

      const body = typeof req.body === "object" && req.body ? req.body : JSON.parse(req.body || "{}");
      const id = req.query?.id;
      if (!id) {
        res.status(400).json({ error: "Event id is required" });
        return;
      }

      const raw = await redis(["LRANGE", KEY, "0", "-1"]);
      const index = (raw || []).findIndex((s) => {
        try {
          return JSON.parse(s).id === id;
        } catch {
          return false;
        }
      });
      if (index === -1) {
        res.status(404).json({ error: "Event not found" });
        return;
      }

      const existing = JSON.parse(raw[index]);
      const updated = {
        ...existing,
        title: body.title !== undefined ? String(body.title).trim().slice(0, 60) || existing.title : existing.title,
        time: body.time !== undefined ? String(body.time).trim().slice(0, 40) : existing.time,
        description:
          body.description !== undefined ? String(body.description).trim().slice(0, 300) : existing.description,
      };

      await redis(["LSET", KEY, String(index), JSON.stringify(updated)]);
      res.status(200).json(updated);
      return;
    }

    if (req.method === "DELETE") {
      if (!checkCode(req, res)) return;

      const id = req.query?.id;
      if (!id) {
        res.status(400).json({ error: "Event id is required" });
        return;
      }
      const raw = await redis(["LRANGE", KEY, "0", "-1"]);
      const match = (raw || []).find((s) => {
        try {
          return JSON.parse(s).id === id;
        } catch {
          return false;
        }
      });
      if (!match) {
        res.status(404).json({ error: "Event not found" });
        return;
      }
      await redis(["LREM", KEY, "1", match]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: "Storage request failed" });
  }
}
