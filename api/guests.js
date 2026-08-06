const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
// Set this in the Vercel project's environment variables. Deletes fail closed if it's
// missing, so an unconfigured deploy can never have its guest list wiped.
const ADMIN_CODE = process.env.ADMIN_CODE;
const KEY = "guests";
const STATUSES = ["going", "maybe", "declined"];
const EVENT_KEYS = ["day", "dinner", "night"];

// POST-with-body form of the Upstash REST API rather than encoding the command into the
// URL path — deleting a single guest sends its full JSON payload as an argument, which is
// far too long/awkward to be a path segment.
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

export default async function handler(req, res) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    res.status(500).json({
      error: "Storage isn't configured — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in the Vercel project's environment variables.",
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

    // Host-only edit of an existing RSVP. Uses LSET at the entry's index so the guest
    // keeps their position in the list rather than jumping to the top.
    if (req.method === "PATCH") {
      const supplied = req.headers["x-admin-code"];
      if (!ADMIN_CODE || supplied !== ADMIN_CODE) {
        res.status(401).json({ error: "Wrong code" });
        return;
      }

      const body = typeof req.body === "object" && req.body ? req.body : JSON.parse(req.body || "{}");
      const id = req.query?.id;
      if (!id) {
        res.status(400).json({ error: "Guest id is required" });
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
        res.status(404).json({ error: "Guest not found" });
        return;
      }

      const existing = JSON.parse(raw[index]);
      const updated = {
        ...existing,
        name: body.name !== undefined ? String(body.name).trim().slice(0, 60) || existing.name : existing.name,
        status: STATUSES.includes(body.status) ? body.status : existing.status,
        attending: Array.isArray(body.attending)
          ? body.attending.filter((k) => EVENT_KEYS.includes(k))
          : existing.attending,
        note: body.note !== undefined ? String(body.note).trim().slice(0, 200) : existing.note,
      };
      // a guest marked as not coming can't be attending anything
      if (updated.status === "declined") updated.attending = [];

      await redis(["LSET", KEY, String(index), JSON.stringify(updated)]);
      res.status(200).json(updated);
      return;
    }

    if (req.method === "DELETE") {
      // Checked here rather than in the UI on purpose: a client-side-only prompt would be
      // cosmetic, since the endpoint can be hit directly with curl.
      const supplied = req.headers["x-admin-code"];
      if (!ADMIN_CODE || supplied !== ADMIN_CODE) {
        res.status(401).json({ error: "Wrong code" });
        return;
      }

      const id = req.query?.id;
      if (id) {
        // Redis LREM matches on the exact stored string, so find the raw entry first
        const raw = await redis(["LRANGE", KEY, "0", "-1"]);
        const match = (raw || []).find((s) => {
          try {
            return JSON.parse(s).id === id;
          } catch {
            return false;
          }
        });
        if (!match) {
          res.status(404).json({ error: "Guest not found" });
          return;
        }
        await redis(["LREM", KEY, "1", match]);
        res.status(200).json({ ok: true });
        return;
      }

      await redis(["DEL", KEY]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: "Storage request failed" });
  }
}
