// Local dev (plain `npm run dev`) has no serverless functions running, so RSVPs
// are kept in this browser's localStorage — fine for design iteration. The
// deployed build talks to /api/guests, backed by a real shared Redis store, so
// every guest's RSVP is visible to everyone.
const DEV = import.meta.env.DEV;
const LOCAL_KEY = "guests";

function readLocal() {
  const raw = window.localStorage.getItem(LOCAL_KEY);
  return raw ? JSON.parse(raw) : [];
}

export async function fetchGuests() {
  if (DEV) return readLocal();
  const res = await fetch("/api/guests");
  if (!res.ok) throw new Error("Failed to load guests");
  return res.json();
}

export async function addGuest(entry) {
  if (DEV) {
    const saved = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
    };
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify([...readLocal(), saved]));
    return saved;
  }
  const res = await fetch("/api/guests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });
  if (!res.ok) throw new Error("Failed to save RSVP");
  return res.json();
}

export async function clearGuests() {
  if (DEV) {
    window.localStorage.removeItem(LOCAL_KEY);
    return;
  }
  const res = await fetch("/api/guests", { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to clear guests");
}
