import { put, del } from "@vercel/blob";

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = "photos";

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

export const config = {
  api: { bodyParser: { sizeLimit: "8mb" } },
};

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
      const photos = (raw || []).map((s) => JSON.parse(s)).reverse();
      res.status(200).json(photos);
      return;
    }

    if (req.method === "POST") {
      const body = typeof req.body === "object" && req.body ? req.body : JSON.parse(req.body || "{}");
      const dataUrl = String(body.dataUrl || "");
      const deviceId = String(body.deviceId || "").trim().slice(0, 60);
      const match = /^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/.exec(dataUrl);
      if (!match || !deviceId) {
        res.status(400).json({ error: "A photo and device id are required" });
        return;
      }
      const [, mime, base64] = match;
      const ext = mime.split("/")[1].replace("jpeg", "jpg").slice(0, 10);
      const buffer = Buffer.from(base64, "base64");
      if (buffer.length > 8 * 1024 * 1024) {
        res.status(400).json({ error: "Photo is too large (8MB max)" });
        return;
      }

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const blob = await put(`photos/${id}.${ext}`, buffer, {
        access: "public",
        contentType: mime,
      });

      const entry = { id, url: blob.url, blobPath: blob.pathname, deviceId, ts: Date.now() };
      await redis(["LPUSH", KEY, JSON.stringify(entry)]);
      res.status(200).json(entry);
      return;
    }

    if (req.method === "DELETE") {
      const id = req.query?.id;
      const deviceId = String(req.headers["x-device-id"] || "").trim();
      if (!id || !deviceId) {
        res.status(400).json({ error: "Photo id and device id are required" });
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
        res.status(404).json({ error: "Photo not found" });
        return;
      }
      const entry = JSON.parse(match);
      // only the device that uploaded a photo can remove it — enforced server-side since
      // a client-side-only check could be bypassed by hitting the endpoint directly
      if (entry.deviceId !== deviceId) {
        res.status(403).json({ error: "You can only delete photos you uploaded" });
        return;
      }

      await del(entry.blobPath);
      await redis(["LREM", KEY, "1", match]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: "Storage request failed" });
  }
}
