// Local dev (plain `npm run dev`) has no serverless functions running, so data is kept in
// this browser's localStorage — fine for design iteration. The deployed build talks to the
// /api routes, backed by a real shared Redis store, so every visitor sees the same data.
const DEV = import.meta.env.DEV;

function readLocal(key) {
  const raw = window.localStorage.getItem(key);
  return raw ? JSON.parse(raw) : [];
}
function writeLocal(key, items) {
  window.localStorage.setItem(key, JSON.stringify(items));
}

// The code is never compared here — it's sent to the API and validated server-side, so it
// never has to exist in the browser bundle. A wrong code comes back as a 401.
export class WrongCodeError extends Error {}

async function sendDelete(url, code) {
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "x-admin-code": code },
  });
  if (res.status === 401) throw new WrongCodeError("Wrong code");
  if (!res.ok) throw new Error("Delete failed");
}

// ---- guests ----

const GUESTS_KEY = "guests";

export async function fetchGuests() {
  if (DEV) return readLocal(GUESTS_KEY);
  const res = await fetch("/api/guests");
  if (!res.ok) throw new Error("Failed to load guests");
  return res.json();
}

export async function addGuest(entry) {
  if (DEV) {
    const saved = { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: Date.now() };
    writeLocal(GUESTS_KEY, [...readLocal(GUESTS_KEY), saved]);
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

export async function clearGuests(code) {
  if (DEV) {
    window.localStorage.removeItem(GUESTS_KEY);
    return;
  }
  await sendDelete("/api/guests", code);
}

export async function deleteGuest(id, code) {
  if (DEV) {
    writeLocal(GUESTS_KEY, readLocal(GUESTS_KEY).filter((g) => g.id !== id));
    return;
  }
  await sendDelete(`/api/guests?id=${encodeURIComponent(id)}`, code);
}

export async function updateGuest(id, patch, code) {
  if (DEV) {
    const next = readLocal(GUESTS_KEY).map((g) => (g.id === id ? { ...g, ...patch } : g));
    writeLocal(GUESTS_KEY, next);
    return next.find((g) => g.id === id);
  }
  const res = await fetch(`/api/guests?id=${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-admin-code": code },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new WrongCodeError("Wrong code");
  if (!res.ok) throw new Error("Update failed");
  return res.json();
}

// ---- itinerary ----

const ITINERARY_KEY = "itinerary";

export async function fetchItinerary() {
  if (DEV) return readLocal(ITINERARY_KEY);
  const res = await fetch("/api/itinerary");
  if (!res.ok) throw new Error("Failed to load itinerary");
  return res.json();
}

export async function addItineraryItem(entry, code) {
  if (DEV) {
    const saved = { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: Date.now() };
    writeLocal(ITINERARY_KEY, [...readLocal(ITINERARY_KEY), saved]);
    return saved;
  }
  const res = await fetch("/api/itinerary", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-code": code },
    body: JSON.stringify(entry),
  });
  if (res.status === 401) throw new WrongCodeError("Wrong code");
  if (!res.ok) throw new Error("Failed to save event");
  return res.json();
}

export async function updateItineraryItem(id, patch, code) {
  if (DEV) {
    const next = readLocal(ITINERARY_KEY).map((i) => (i.id === id ? { ...i, ...patch } : i));
    writeLocal(ITINERARY_KEY, next);
    return next.find((i) => i.id === id);
  }
  const res = await fetch(`/api/itinerary?id=${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-admin-code": code },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new WrongCodeError("Wrong code");
  if (!res.ok) throw new Error("Failed to update event");
  return res.json();
}

export async function deleteItineraryItem(id, code) {
  if (DEV) {
    writeLocal(ITINERARY_KEY, readLocal(ITINERARY_KEY).filter((i) => i.id !== id));
    return;
  }
  await sendDelete(`/api/itinerary?id=${encodeURIComponent(id)}`, code);
}
