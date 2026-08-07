import { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { MapPin, Calendar, CalendarPlus, Check, Loader2, Ticket as TicketIcon, X, ChevronRight, Images, Upload, Trash2, Lock, RotateCw, CheckSquare, Share2, Plus, ArrowLeft, SkipForward } from "lucide-react";
import {
  fetchGuests,
  addGuest,
  clearGuests,
  deleteGuest,
  updateGuest,
  fetchItinerary,
  addItineraryItem,
  updateItineraryItem,
  deleteItineraryItem,
  fetchPhotos,
  uploadPhoto,
  deletePhoto,
  getDeviceId,
  WrongCodeError,
} from "./api.js";

const TIMELINE_COLORS = ["#4ADE80", "#FBBF24", "#60A5FA", "#F472B6", "#93A980", "#F87171"];

// Itinerary times are stored as 24h "HH:MM" strings — zero-padded so they sort correctly
// as plain strings, and unambiguous to parse back into a 12h display or picker state.
const DEFAULT_TIME_24 = "19:00"; // 7:00 PM — a reasonable default for a party stop
const MINUTE_STEPS = Array.from({ length: 12 }, (_, i) => i * 5); // :00, :05, ... :55

function time24ToParts(time24) {
  const m = /^(\d{2}):(\d{2})$/.exec(time24 || "");
  if (!m) return { hour12: 7, minute: 0, meridiem: "PM" };
  const h = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const meridiem = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return { hour12, minute, meridiem };
}

function partsToTime24(hour12, minute, meridiem) {
  let h = hour12 % 12;
  if (meridiem === "PM") h += 12;
  return `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatTime12(time24) {
  if (!/^\d{2}:\d{2}$/.test(time24 || "")) return "";
  const { hour12, minute, meridiem } = time24ToParts(time24);
  return `${hour12}:${String(minute).padStart(2, "0")} ${meridiem}`;
}

// events without a valid time sort to the end rather than breaking the sort
function sortByTime(items) {
  return [...items].sort((a, b) => {
    const ta = /^\d{2}:\d{2}$/.test(a.time) ? a.time : "99:99";
    const tb = /^\d{2}:\d{2}$/.test(b.time) ? b.time : "99:99";
    return ta.localeCompare(tb);
  });
}

// Cached in sessionStorage (not localStorage) on purpose — "this session" should mean
// this tab, cleared when it's closed, not a permanent login. The code is still validated
// server-side on every request; this only skips re-prompting client-side.
const ADMIN_CODE_KEY = "adminCode";

function getAdminCode(promptMessage) {
  try {
    const cached = sessionStorage.getItem(ADMIN_CODE_KEY);
    if (cached) return cached;
  } catch (e) {
    // sessionStorage unavailable (private browsing etc.) — fall through to prompting
  }
  const entered = window.prompt(promptMessage);
  if (!entered) return null;
  try {
    sessionStorage.setItem(ADMIN_CODE_KEY, entered);
  } catch (e) {
    // ignore — worst case it just prompts again next time
  }
  return entered;
}

// true once a code has been entered this session — good enough to grant early album access
// without prompting again, since a wrong code gets forgotten the moment any admin write 401s
function hasCachedAdminCode() {
  try {
    return !!sessionStorage.getItem(ADMIN_CODE_KEY);
  } catch (e) {
    return false;
  }
}

function forgetAdminCode() {
  try {
    sessionStorage.removeItem(ADMIN_CODE_KEY);
  } catch (e) {
    // ignore
  }
}

const FALL_MS = 900;
const CLAIM_MS = 320;
const LAND_SCALE = 1.5;
const POUR_MS = 5000;
const BOOT_FADE_MS = 500;

const GUEST_TABS = [
  { key: "going", label: "Going", color: "#4ADE80" },
  { key: "maybe", label: "Maybe", color: "#FBBF24" },
  { key: "declined", label: "Can't go", color: "#F87171" },
];

const EVENTS = [
  { key: "day", label: "Day Hang", icon: "☀️" },
  { key: "dinner", label: "Dinner", icon: "🍽️" },
  { key: "night", label: "Night Outing", icon: "🌙" },
];

// Sept 19 2026, 9pm local — the countdown target
const EVENT_DATE = new Date(2026, 8, 19, 21, 0, 0);

// Per-stop venues live in the itinerary (added closer to the date), so this is just the
// city-level anchor rather than a single address.
const CITY = "Charlotte, NC";

function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

// hand-rolled, uncompressed ("stored") ZIP writer — the desktop fallback for saving
// multiple photos at once, used only when the Web Share API's multi-file share isn't
// available. No compression means no dependency and no worker thread, at the cost of a
// slightly bigger file than a real zip library would produce.
async function filesToZipBlob(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = new Uint8Array(await file.arrayBuffer());
    const crc = crc32(data);
    const size = data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    localParts.push(new Uint8Array(local.buffer), nameBytes, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, 0, true);
    central.setUint16(14, 0, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, offset, true);
    centralParts.push(new Uint8Array(central.buffer), nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  const centralStart = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);

  return new Blob([...localParts, ...centralParts, new Uint8Array(end.buffer)], { type: "application/zip" });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// downscales + re-encodes to JPEG client-side before upload — phone camera photos are
// easily 4-8MB, which is slow to upload and wasteful to store for a shared album
function resizeImageToDataUrl(file, maxDim = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Couldn't read that image"));
    };
    img.src = objectUrl;
  });
}

// UTC-based, no trailing "Z", stamped to local wall-clock digits — good enough for a
// single all-day-ish birthday event without pulling in a timezone library.
function icsStamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(
    date.getMinutes()
  )}${pad(date.getSeconds())}`;
}

function downloadInviteIcs() {
  const start = EVENT_DATE;
  const end = new Date(start.getTime() + 6 * 60 * 60 * 1000); // rough all-day-outing block
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Alex & Kylie's Birthday//EN",
    "BEGIN:VEVENT",
    `UID:alex-kylie-bday-2026@event-invite`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    "SUMMARY:Alex & Kylie's Birthday",
    `LOCATION:${CITY}`,
    "DESCRIPTION:Alex & Kylie are turning 26 & 23 — see the app for the full itinerary.",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  downloadBlob(new Blob([ics], { type: "text/calendar;charset=utf-8" }), "alex-and-kylie-birthday.ics");
}

function useCountdown(target) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const diff = target.getTime() - now;
  if (diff <= 0) return null;
  return {
    days: Math.floor(diff / 86400000),
    hours: Math.floor((diff / 3600000) % 24),
    minutes: Math.floor((diff / 60000) % 60),
    seconds: Math.floor((diff / 1000) % 60),
  };
}

export default function BirthdayInvite() {
  // idle -> printing -> falling -> landed -> claiming -> claimed
  const [stage, setStage] = useState("idle");
  const [flightStyle, setFlightStyle] = useState(null);
  const ticketRef = useRef(null);
  const [guests, setGuests] = useState([]);
  const [loadingGuests, setLoadingGuests] = useState(true);
  const [guestTab, setGuestTab] = useState("going");
  const [name, setName] = useState("");
  const [status, setStatus] = useState("going");
  const [attending, setAttending] = useState([]);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [selectedGuest, setSelectedGuest] = useState(null);
  const [showItinerary, setShowItinerary] = useState(false);
  const [itinerary, setItinerary] = useState([]);
  const [loadingItinerary, setLoadingItinerary] = useState(true);
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [adminEvent, setAdminEvent] = useState(null);
  const [adminGuest, setAdminGuest] = useState(null);
  const [adminCode, setAdminCode] = useState("");
  const [showAlbum, setShowAlbum] = useState(false);
  const [showAlbumLocked, setShowAlbumLocked] = useState(false);
  const [photos, setPhotos] = useState([]);
  const [loadingPhotos, setLoadingPhotos] = useState(true);
  const secretTaps = useRef({ count: 0, timer: null });
  const guestListRef = useRef(null);

  useEffect(() => {
    if (!showItinerary) return;
    (async () => {
      try {
        setItinerary(await fetchItinerary());
      } catch (e) {
        // no events yet — empty timeline is fine
      } finally {
        setLoadingItinerary(false);
      }
    })();
  }, [showItinerary]);

  useEffect(() => {
    if (!showAlbum) return;
    (async () => {
      try {
        setPhotos(await fetchPhotos());
      } catch (e) {
        // no photos yet — empty album is fine
      } finally {
        setLoadingPhotos(false);
      }
    })();
  }, [showAlbum]);

  useEffect(() => {
    if (submitted) {
      guestListRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [submitted]);

  const reducedMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    []
  );

  const [booting, setBooting] = useState(!reducedMotion);
  const [bootFading, setBootFading] = useState(false);

  useEffect(() => {
    if (!booting) return;
    const fadeTimer = setTimeout(() => setBootFading(true), POUR_MS);
    const doneTimer = setTimeout(() => setBooting(false), POUR_MS + BOOT_FADE_MS);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(doneTimer);
    };
  }, [booting]);

  useEffect(() => {
    if (reducedMotion) setStage("claimed");
  }, [reducedMotion]);

  function skipBoot() {
    setStage("claimed");
    setBootFading(true);
    setTimeout(() => setBooting(false), BOOT_FADE_MS);
  }

  function printTicket() {
    if (stage !== "idle") return;
    setStage("printing");
    setTimeout(() => setStage("falling"), 1500); // stutter-print, then it lets go
  }

  // once printing lets go, measure exactly where the ticket sits on screen and
  // let it fall from there — no hardcoded coordinates, so there's no jump/cut.
  useLayoutEffect(() => {
    if (stage !== "falling") return;
    const el = ticketRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();

    setFlightStyle({
      position: "fixed",
      left: rect.left,
      top: rect.top,
      width: rect.width,
      margin: 0,
      transform: "rotate(0deg)",
      transition: "none",
    });

    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // the anchor point (targetLeft/targetTop describe the box's center) stays
        // fixed regardless of scale, since transform-origin is the box's center —
        // so growing it here doesn't throw off the centering math below.
        const targetLeft = vw / 2 - rect.width / 2;
        const targetTop = vh * 0.46 - rect.height / 2;
        setFlightStyle({
          position: "fixed",
          left: targetLeft,
          top: targetTop,
          width: rect.width,
          margin: 0,
          transform: `rotate(0deg) scale(${LAND_SCALE})`,
          transition: `left ${FALL_MS}ms cubic-bezier(.55,0,.85,.4), top ${FALL_MS}ms cubic-bezier(.2,.9,.35,1.28), transform ${FALL_MS}ms cubic-bezier(.22,1,.36,1)`,
        });
      });
    });

    const settle = setTimeout(() => setStage("landed"), FALL_MS + 60);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
    };
  }, [stage]);

  function claimTicket() {
    if (stage !== "landed") return;
    setStage("claiming");
    setFlightStyle((prev) => ({
      ...prev,
      transform: `scale(${LAND_SCALE * 0.94})`,
      opacity: 0,
      transition: `transform ${CLAIM_MS}ms ease-in, opacity ${CLAIM_MS}ms ease-in`,
    }));
    setTimeout(() => setStage("claimed"), CLAIM_MS);
  }

  useEffect(() => {
    if (stage !== "landed" && stage !== "claiming" && stage !== "claimed") return;
    (async () => {
      try {
        setGuests(await fetchGuests());
      } catch (e) {
        // no guests yet — empty list is fine
      } finally {
        setLoadingGuests(false);
      }
    })();
  }, [stage]);

  // secret: 5 quick taps on "Who's coming" clears the guest list — no visible button
  function handleSecretTap() {
    const s = secretTaps.current;
    s.count += 1;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.count = 0;
    }, 1200);
    if (s.count >= 5) {
      s.count = 0;
      const code = getAdminCode("Enter the code to clear the ENTIRE guest list:");
      if (!code) return;
      (async () => {
        try {
          await clearGuests(code);
          setGuests([]);
        } catch (e) {
          if (e instanceof WrongCodeError) forgetAdminCode();
          window.alert(e instanceof WrongCodeError ? "Wrong code." : "Couldn't clear the list.");
        }
      })();
    }
  }

  // long-press a guest row -> code prompt (skipped if already entered this session) ->
  // host view where their RSVP can be edited. The code isn't verified here; it's sent
  // with the save/remove request and validated server-side, so there's no way to bypass
  // it by poking at the client.
  function handleLongPressGuest(guest) {
    const code = getAdminCode(`Manage ${guest.name}'s RSVP — enter the code:`);
    if (!code) return;
    setAdminCode(code);
    setAdminGuest(guest);
  }

  async function handleAdminSave(patch) {
    try {
      const saved = await updateGuest(adminGuest.id, patch, adminCode);
      setGuests((prev) => prev.map((g) => (g.id === adminGuest.id ? { ...g, ...(saved || patch) } : g)));
      setAdminGuest(null);
    } catch (e) {
      if (e instanceof WrongCodeError) forgetAdminCode();
      throw e;
    }
  }

  async function handleAdminDelete() {
    try {
      await deleteGuest(adminGuest.id, adminCode);
      setGuests((prev) => prev.filter((g) => g.id !== adminGuest.id));
      setAdminGuest(null);
    } catch (e) {
      if (e instanceof WrongCodeError) forgetAdminCode();
      throw e;
    }
  }

  function handleAddEventClick() {
    const code = getAdminCode("Enter the code to add an event:");
    if (!code) return;
    setAdminCode(code);
    setAdminEvent(null);
    setShowAddEvent(true);
  }

  // long-press a timeline item -> code prompt (skipped if cached) -> edit form.
  function handleLongPressEvent(item) {
    const code = getAdminCode(`Edit "${item.title}" — enter the code:`);
    if (!code) return;
    setAdminCode(code);
    setAdminEvent(item);
  }

  async function handleEventSave(patch) {
    try {
      if (adminEvent) {
        const saved = await updateItineraryItem(adminEvent.id, patch, adminCode);
        setItinerary((prev) => prev.map((i) => (i.id === adminEvent.id ? { ...i, ...(saved || patch) } : i)));
        setAdminEvent(null);
      } else {
        const saved = await addItineraryItem(patch, adminCode);
        setItinerary((prev) => [...prev, saved]);
        setShowAddEvent(false);
      }
    } catch (e) {
      if (e instanceof WrongCodeError) forgetAdminCode();
      throw e;
    }
  }

  async function handleEventDelete() {
    try {
      await deleteItineraryItem(adminEvent.id, adminCode);
      setItinerary((prev) => prev.filter((i) => i.id !== adminEvent.id));
      setAdminEvent(null);
    } catch (e) {
      if (e instanceof WrongCodeError) forgetAdminCode();
      throw e;
    }
  }

  function handleAlbumClick() {
    if (albumUnlocked || hasCachedAdminCode()) {
      setShowAlbum(true);
    } else {
      setShowAlbumLocked(true);
    }
  }

  function handleAlbumUnlockWithCode() {
    const code = getAdminCode("Enter the host code for early access:");
    if (!code) return;
    setAdminCode(code);
    setShowAlbumLocked(false);
    setShowAlbum(true);
  }

  async function handlePhotoUpload(file, title = "", caption = "") {
    const dataUrl = await resizeImageToDataUrl(file);
    const saved = await uploadPhoto(dataUrl, title, caption);
    setPhotos((prev) => [saved, ...prev]);
  }

  async function handlePhotoDelete(photo) {
    if (!window.confirm("Delete this photo?")) return;
    await deletePhoto(photo.id);
    setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
  }

  function toggleAttending(key) {
    setAttending((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Tell us who's coming!");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      const saved = await addGuest({
        name: name.trim(),
        status,
        attending: status === "declined" ? [] : attending,
        note: note.trim(),
      });
      setGuests((prev) => [...prev, saved]);
      setSubmitted(true);
      setName("");
      setNote("");
      setStatus("going");
      setAttending([]);
    } catch (err) {
      setError("Couldn't save your RSVP — give it another try.");
    } finally {
      setSubmitting(false);
    }
  }

  const going = guests.filter((g) => g.status === "going");
  const maybe = guests.filter((g) => g.status === "maybe");
  const declined = guests.filter((g) => g.status === "declined");
  const headcount = going.length;
  const guestTabCounts = { going: going.length, maybe: maybe.length, declined: declined.length };
  const activeGuestGroup = guestTab === "going" ? going : guestTab === "maybe" ? maybe : declined;
  const activeTabInfo = GUEST_TABS.find((t) => t.key === guestTab);
  // TEMPORARY: ?album=1 in the URL previews the photo album before the real unlock date so
  // it can be checked on a real phone ahead of the event. Remove this line (and the ?album=1
  // param) once the album has been tested — the date-based unlock below is the real gate.
  const albumPreview = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("album");
  const albumUnlocked = albumPreview || Date.now() >= EVENT_DATE.getTime();

  const showIntro = stage !== "claimed";
  const showMachine = stage === "idle" || stage === "printing";
  const ticketInteractive = stage === "landed";
  const showPage = stage === "claimed";

  return (
    <div
      className="inv-root"
      style={{
        // transparent on purpose — html/body carry the solid color (set in index.html) and
        // .party-bg is the real fixed, full-screen layer; a THIRD opaque layer here, sized
        // only to this div's content box, is exactly what can leave Safari's safe-area
        // (behind the collapsible toolbars) unpainted or sampling the wrong color
        background: "transparent",
        minHeight: "100dvh",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <style>{`
        :root {
          --ink: #1B1420;
          --muted: rgba(255,255,255,0.55);
          --bg-solid: #100C15;
          --accent-a: #2E4A73;
          --accent-b: #93A980;
          --glow-a: rgba(46,74,115,0.34);
          --glow-b: rgba(147,169,128,0.26);
        }
        .inv-root, .inv-root * { box-sizing: border-box; }
        .inv-root { font-family: 'Plus Jakarta Sans', sans-serif; color: #fff; }
        .serif { font-family: 'Fraunces', serif; }

        /* only the drifting glow blobs live here. The gradient itself is #bg-gradient in
           index.html — outside the React tree, because .inv-root's overflow:hidden clips
           even position:fixed descendants in Safari, which is what kept cutting the
           gradient off at the top and bottom. */
        .party-bg {
          position: fixed; inset: 0; z-index: 0; pointer-events: none;
          background: transparent;
        }
        .party-bg span {
          position: absolute; border-radius: 50%; filter: blur(85px);
          animation: blob-drift 16s ease-in-out infinite;
          transition: background-color 0.8s ease;
        }
        @keyframes blob-drift {
          0%   { transform: translate(0,0) scale(1); }
          33%  { transform: translate(60px,-45px) scale(1.18); }
          66%  { transform: translate(-40px,35px) scale(0.92); }
          100% { transform: translate(0,0) scale(1); }
        }

        .glass-panel {
          background: rgba(255,255,255,0.085);
          backdrop-filter: blur(24px) saturate(180%);
          -webkit-backdrop-filter: blur(24px) saturate(180%);
          border-radius: 24px;
          border: 1px solid rgba(255,255,255,0.16);
          box-shadow: inset 0 1px 0 0 rgba(255,255,255,0.22), 0 20px 50px -20px rgba(0,0,0,0.65);
          color: #fff;
          transition: background 0.5s ease, border-color 0.5s ease;
        }

        .pill-btn {
          border: none; cursor: pointer; font-weight: 700; font-family: 'Plus Jakarta Sans', sans-serif;
          border-radius: 999px; transition: transform .3s cubic-bezier(.22,1,.36,1), box-shadow .3s cubic-bezier(.22,1,.36,1);
        }
        .pill-btn:hover { transform: scale(1.03) translateY(-1px); }
        .pill-btn:active { transform: scale(0.98); }
        .pill-btn:disabled { opacity: 0.6; cursor: default; transform: none; }

        .pill-primary {
          background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
          color: #fff;
          text-shadow: 0 1px 2px rgba(0,0,0,0.35);
          box-shadow: 0 10px 26px -6px rgba(0,0,0,0.5);
        }

        .ghost-btn {
          padding: 12px 22px; font-size: 14px;
          background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.2);
          color: #fff;
          display: inline-flex; align-items: center; gap: 8px;
          transition: background .2s ease, border-color .2s ease, transform .3s cubic-bezier(.22,1,.36,1);
        }
        .ghost-btn:hover { background: rgba(255,255,255,0.14); border-color: rgba(255,255,255,0.35); }

        .danger-btn {
          padding: 12px 18px; font-size: 14px; border-radius: 12px;
          background: rgba(255,90,90,0.12);
          border: 1px solid rgba(255,120,120,0.45);
          color: #FF9B9B;
          transition: background .2s ease, border-color .2s ease;
        }
        .danger-btn:hover { background: rgba(255,90,90,0.2); border-color: rgba(255,120,120,0.7); }

        .itinerary-modal { max-height: 82vh; overflow-y: auto; }
        .itinerary-timeline {
          position: relative; display: grid; gap: 22px; padding-left: 28px;
        }
        .itinerary-timeline::before {
          /* centered at x=6 (5px + half of the 2px width) — .itinerary-dot below is
             positioned to land on that same x=6 center, see the note there */
          content: ""; position: absolute; left: 5px; top: 6px; bottom: 6px; width: 2px;
          background: rgba(255,255,255,0.14);
        }
        .itinerary-item {
          /* negative margin only on top/right/bottom, deliberately NOT left — the left
             edge has to stay exactly at the timeline's padding-left (28px) because
             .itinerary-dot's position is computed relative to it. A symmetric negative
             margin here previously shifted the row 8px left of where the dot assumed,
             which is what threw the line/dot alignment off. */
          position: relative; cursor: pointer; border-radius: 10px; padding: 5px 8px 5px 0;
          margin: -5px -8px -5px 0; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none;
          transition: background .2s ease, transform .15s ease;
        }
        .itinerary-item-pressing {
          background: rgba(255,255,255,0.08);
          transform: scale(0.98);
          transition: background .2s ease, transform ${LONG_PRESS_MS}ms ease;
        }
        .itinerary-dot {
          /* item's left edge sits at global x=28 (timeline's padding-left, since the item
             itself has no left margin/padding). To land this 12px dot's center on the
             line's center (global x=6): left = 6 - 6(half dot) - 28(item offset) = -28 */
          position: absolute; left: -28px; top: 5px; width: 12px; height: 12px; border-radius: 50%;
        }
        .itinerary-time {
          font-size: 11px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase;
          opacity: 0.55; margin-bottom: 2px;
        }
        .itinerary-title { font-size: 15.5px; font-weight: 700; }
        .itinerary-desc { font-size: 13px; opacity: 0.7; margin-top: 4px; line-height: 1.5; }

        /* the album is its own full screen (not a modal), swapped in for .page-content */
        .album-screen {
          padding-top: calc(108px + env(safe-area-inset-top));
          padding-bottom: max(110px, calc(96px + env(safe-area-inset-bottom)));
        }
        /* fixed so Back/Select stay put while the photo list scrolls underneath — a fading
           scrim (not a solid bar) so it doesn't hard-clip whatever photo is behind it */
        .album-topbar {
          position: fixed; top: 0; left: 0; right: 0; z-index: 25;
          display: flex; align-items: center; justify-content: space-between;
          padding: max(16px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) 24px
            max(20px, env(safe-area-inset-left));
          background: linear-gradient(to bottom, rgba(10,8,14,0.85) 0%, rgba(10,8,14,0.5) 60%, transparent 100%);
          pointer-events: none;
        }
        .album-topbar-btn {
          pointer-events: auto; cursor: pointer;
          display: inline-flex; align-items: center; gap: 6px;
          padding: 9px 16px; border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.22);
          background: rgba(30,26,38,0.6);
          backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
          color: #fff; font-family: 'Plus Jakarta Sans', sans-serif; font-weight: 700; font-size: 13px;
          transition: background .2s ease, border-color .2s ease, transform .15s ease;
        }
        .album-topbar-btn:hover { background: rgba(255,255,255,0.16); border-color: rgba(255,255,255,0.4); }
        .album-topbar-btn:active { transform: scale(0.94); }
        .album-view-toggle {
          display: flex; align-items: center; gap: 12px; align-self: center; margin-bottom: 20px;
          font-family: 'Plus Jakarta Sans', sans-serif; font-size: 13.5px; font-weight: 800;
          letter-spacing: 0.3px;
        }
        .album-view-toggle button {
          background: none; border: none; cursor: pointer; padding: 4px 2px;
          color: rgba(255,255,255,0.4); transition: color .2s ease;
        }
        .album-view-toggle button.active { color: #fff; }
        .album-view-divider { width: 1px; height: 14px; background: rgba(255,255,255,0.22); }

        .album-list { display: flex; flex-direction: column; gap: 18px; width: 100%; }
        /* bigger than the original small-tile grid — two columns, not three */
        .album-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; width: 100%; }
        /* same dark-metal treatment as the ticket card, one big card per photo */
        .album-card {
          position: relative; width: 100%; aspect-ratio: 4 / 5; max-height: 58vh; border-radius: 22px; overflow: hidden;
          background: linear-gradient(155deg, #2A2534 0%, #14111B 60%, #0A0810 100%);
          border: 1px solid rgba(255,255,255,0.09);
          box-shadow: 0 20px 44px -14px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.08);
          transition: transform .15s ease;
        }
        .album-grid .album-card { aspect-ratio: 1; border-radius: 18px; }
        .album-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .photo-tile-selectable { cursor: pointer; }
        .photo-tile-selectable:active { transform: scale(0.97); }
        .photo-delete {
          position: absolute; top: 10px; right: 10px; width: 30px; height: 30px; border-radius: 50%;
          background: rgba(10,8,14,0.72); border: 1px solid rgba(255,255,255,0.25); color: #FF9B9B;
          display: flex; align-items: center; justify-content: center; cursor: pointer;
          backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
          transition: background .2s ease, transform .15s ease;
        }
        .photo-delete:hover { background: rgba(255,90,90,0.3); }
        .photo-delete:active { transform: scale(0.9); }
        .photo-select-mark {
          position: absolute; top: 10px; right: 10px; width: 28px; height: 28px; border-radius: 50%;
          background: rgba(10,8,14,0.6); border: 1.5px solid rgba(255,255,255,0.5);
          display: flex; align-items: center; justify-content: center; color: #fff;
          backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
          transition: background .2s ease, border-color .2s ease;
        }
        .photo-tile-selected .photo-select-mark {
          background: var(--accent-b); border-color: var(--accent-b);
        }
        .photo-tile-selected { outline: 2px solid var(--accent-b); outline-offset: 2px; }

        /* "+" upload button — pinned to the viewport so it's reachable no matter how far
           you've scrolled through the album */
        .album-fab {
          position: fixed; z-index: 25; border: none; cursor: pointer;
          right: max(22px, env(safe-area-inset-right)); bottom: max(22px, env(safe-area-inset-bottom));
          width: 66px; height: 66px; border-radius: 50%;
          background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
          color: #fff; display: flex; align-items: center; justify-content: center;
          box-shadow: 0 14px 30px -8px rgba(0,0,0,0.6), 0 0 0 0 rgba(147,169,128,0.5);
          transition: transform .35s cubic-bezier(.34,1.56,.64,1), box-shadow .35s ease;
          /* fab-pop has no fill-mode, so once it finishes (0.5s) the transform property is
             free again for the :active transition below — an indefinite fill would win over
             that transition permanently, since animations always beat transitions on a
             shared property while in effect */
          animation: fab-pop .5s cubic-bezier(.34,1.56,.64,1), fab-breathe 2.8s ease-in-out .5s infinite;
        }
        .album-fab svg { transition: transform .3s cubic-bezier(.34,1.56,.64,1); }
        .album-fab:hover svg { transform: rotate(90deg); }
        .album-fab:active { transform: scale(0.88); }
        .album-fab:active svg { transform: rotate(135deg); }
        .album-fab:disabled { opacity: 0.6; cursor: default; animation: none; }
        @keyframes fab-pop {
          0% { transform: scale(0) rotate(-45deg); opacity: 0; }
          70% { transform: scale(1.12) rotate(6deg); opacity: 1; }
          100% { transform: scale(1) rotate(0deg); opacity: 1; }
        }
        @keyframes fab-breathe {
          0%, 100% { box-shadow: 0 14px 30px -8px rgba(0,0,0,0.6), 0 0 0 0 rgba(147,169,128,0.45); }
          50% { box-shadow: 0 14px 30px -8px rgba(0,0,0,0.6), 0 0 0 10px rgba(147,169,128,0); }
        }
        .album-select-bar {
          position: fixed; z-index: 25; left: 50%; transform: translateX(-50%);
          bottom: max(22px, env(safe-area-inset-bottom));
          display: flex; align-items: center; gap: 14px;
          background: rgba(20,17,27,0.92);
          backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
          border: 1px solid rgba(255,255,255,0.14); border-radius: 999px;
          padding: 10px 10px 10px 18px;
          box-shadow: 0 14px 30px -8px rgba(0,0,0,0.6);
        }

        .photo-skip-all {
          display: flex; align-items: center; justify-content: center; gap: 6px;
          width: 100%; margin-top: 12px; padding: 10px 0; cursor: pointer;
          background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.16);
          border-radius: 999px;
          font-family: 'Plus Jakarta Sans', sans-serif; font-size: 12.5px; font-weight: 700;
          color: rgba(255,255,255,0.65); transition: background .2s ease, border-color .2s ease, color .2s ease;
        }
        .photo-skip-all:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.32); color: #fff; }
        .photo-skip-all:active { transform: scale(0.98); }
        .photo-skip-all:disabled { cursor: default; opacity: 0.6; transform: none; }

        .time-picker { display: flex; align-items: center; gap: 6px; }
        .time-picker-select {
          background: rgba(0,0,0,0.24); border: 1px solid rgba(255,255,255,0.16);
          color: #fff; border-radius: 12px; padding: 12px 10px; font-size: 15px; font-weight: 600;
          font-family: 'Plus Jakarta Sans', sans-serif; outline: none;
          box-shadow: inset 0 1px 4px rgba(0,0,0,0.35);
          transition: border-color .2s ease, background .2s ease;
        }
        .time-picker-select:hover { border-color: rgba(255,255,255,0.3); }
        .time-picker-select:focus { border-color: var(--accent-a); }
        .time-picker-select option { background: #1B1420; color: #fff; }
        .time-picker-colon { font-weight: 800; opacity: 0.6; }
        /* same sliding-pill mechanic as .status-group/.status-slider on the RSVP status
           picker — a single animated pill translates behind whichever option is active,
           instead of each button swapping its own background independently */
        .meridiem-toggle {
          position: relative; display: flex; margin-left: auto; padding: 3px; border-radius: 12px;
          background: rgba(0,0,0,0.22); border: 1px solid rgba(255,255,255,0.14);
          box-shadow: inset 0 1px 4px rgba(0,0,0,0.3);
        }
        .meridiem-slider {
          position: absolute; top: 3px; bottom: 3px; left: 3px;
          width: calc((100% - 6px) / 2); border-radius: 9px;
          background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
          box-shadow: 0 4px 14px -4px rgba(0,0,0,0.55);
          transition: transform 0.32s cubic-bezier(.22,1,.36,1);
          z-index: 0;
        }
        .meridiem-toggle button {
          position: relative; z-index: 1;
          border: none; background: transparent; color: rgba(255,255,255,0.65); font-weight: 700;
          font-size: 12.5px; padding: 9px 14px; border-radius: 9px; cursor: pointer;
          font-family: 'Plus Jakarta Sans', sans-serif; transition: color .25s ease;
        }
        .meridiem-toggle button.active { color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.35); }

        .field {
          width: 100%; background: rgba(0,0,0,0.24); border: 1px solid rgba(255,255,255,0.16);
          color: #fff; border-radius: 14px; padding: 13px 15px; font-size: 15px;
          font-family: 'Plus Jakarta Sans', sans-serif; outline: none; font-weight: 600;
          box-shadow: inset 0 1px 4px rgba(0,0,0,0.35);
          transition: border-color .2s ease, box-shadow .2s ease, background .2s ease;
        }
        .field:hover { border-color: rgba(255,255,255,0.3); background: rgba(0,0,0,0.3); }
        .field:focus {
          border-color: var(--accent-a);
          background: rgba(0,0,0,0.3);
          box-shadow: inset 0 1px 4px rgba(0,0,0,0.35), 0 0 0 3px var(--accent-a);
        }
        .field::placeholder { color: rgba(255,255,255,0.4); font-weight: 500; }

        .status-group {
          position: relative; display: flex; padding: 3px; border-radius: 13px;
          background: rgba(0,0,0,0.22); border: 1px solid rgba(255,255,255,0.14);
          box-shadow: inset 0 1px 4px rgba(0,0,0,0.3);
        }
        .status-slider {
          position: absolute; top: 3px; bottom: 3px; left: 3px;
          width: calc((100% - 6px) / 3); border-radius: 10px;
          background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
          box-shadow: 0 4px 14px -4px rgba(0,0,0,0.55);
          transition: transform 0.32s cubic-bezier(.22,1,.36,1);
          z-index: 0;
        }
        .status-chip {
          position: relative; z-index: 1; flex: 1; border: none; background: transparent;
          padding: 10px 4px; border-radius: 10px; color: rgba(255,255,255,0.65); font-weight: 700;
          cursor: pointer; font-size: 12.5px; white-space: nowrap;
          font-family: 'Plus Jakarta Sans', sans-serif;
          transition: color .25s ease, background .2s ease, transform .15s ease;
        }
        .status-chip:hover { background: rgba(255,255,255,0.07); color: #fff; }
        .status-chip:active { transform: scale(0.96); }
        .status-chip.active { color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.35); }
        .status-chip.active:hover { background: transparent; }

        .event-chip {
          flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
          padding: 10px 6px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.18);
          background: rgba(255,255,255,0.075); color: rgba(255,255,255,0.85); font-weight: 700;
          font-size: 12px; cursor: pointer; white-space: nowrap; font-family: 'Plus Jakarta Sans', sans-serif;
          box-shadow: 0 2px 6px -2px rgba(0,0,0,0.35);
          transition: border-color .2s ease, background .2s ease, transform .15s ease, box-shadow .2s ease;
        }
        .event-chip:hover {
          border-color: rgba(255,255,255,0.4); background: rgba(255,255,255,0.13);
          box-shadow: 0 4px 10px -3px rgba(0,0,0,0.45);
        }
        .event-chip:active { transform: scale(0.96); }
        .event-chip.active { border-color: rgba(74,222,128,0.6); background: rgba(74,222,128,0.14); color: #fff; }
        .event-chip.active:hover { background: rgba(74,222,128,0.2); }
        .event-chip-check {
          width: 15px; height: 15px; border-radius: 50%; flex-shrink: 0;
          border: 1.5px solid rgba(255,255,255,0.35);
          display: flex; align-items: center; justify-content: center; color: #0B0810;
          transition: background .2s ease, border-color .2s ease;
        }
        .event-chip.active .event-chip-check { background: #4ADE80; border-color: #4ADE80; }

        .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }

        .guest-tabs {
          display: flex; gap: 8px; margin-bottom: 16px; overflow-x: auto;
          -ms-overflow-style: none; scrollbar-width: none;
        }
        .guest-tabs::-webkit-scrollbar { display: none; }
        .guest-tab {
          display: flex; align-items: center; gap: 6px; flex-shrink: 0;
          background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.14);
          border-radius: 999px; padding: 7px 12px; cursor: pointer;
          font-family: 'Plus Jakarta Sans', sans-serif; font-size: 12.5px; font-weight: 700;
          color: rgba(255,255,255,0.6); transition: background .2s ease, border-color .2s ease, color .2s ease;
        }
        .guest-tab:hover { color: rgba(255,255,255,0.85); }
        .guest-tab-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
        .guest-tab-count {
          font-size: 11px; font-weight: 800; opacity: 0.65; background: rgba(255,255,255,0.1);
          border-radius: 999px; padding: 1px 6px;
        }

        .guest-row {
          display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; text-align: left;
          background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.16); border-radius: 12px;
          padding: 10px 12px 10px 7px; cursor: pointer; font-family: 'Plus Jakarta Sans', sans-serif;
          box-shadow: 0 2px 6px -2px rgba(0,0,0,0.35);
          transition: background .2s ease, border-color .2s ease, transform .15s ease, box-shadow .2s ease;
          color: #fff;
        }
        .guest-row:hover {
          background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.34);
          transform: translateY(-1px); box-shadow: 0 6px 14px -4px rgba(0,0,0,0.5);
        }
        .guest-row:active { transform: scale(0.98) translateY(0); }
        /* visible feedback that a long-press is in progress, so the delete prompt doesn't
           appear out of nowhere. Also suppresses the iOS text-selection/callout on hold. */
        .guest-row { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
        .guest-row-pressing {
          transform: scale(0.97);
          border-color: rgba(255,120,120,0.55) !important;
          background: rgba(255,90,90,0.12) !important;
          transition: transform ${LONG_PRESS_MS}ms ease, background .2s ease, border-color .2s ease;
        }
        .guest-row-name { font-weight: 700; font-size: 13.5px; flex-shrink: 0; }
        .guest-row-events { font-size: 12px; flex-shrink: 0; opacity: 0.9; }
        .guest-row-chevron { flex-shrink: 0; margin-left: auto; opacity: 0.45; transition: opacity .2s ease, transform .2s ease; }
        .guest-row:hover .guest-row-chevron { opacity: 0.85; transform: translateX(2px); }
        .guest-row-note {
          font-size: 12.5px; color: rgba(255,255,255,0.5); font-style: italic;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
        }

        .guest-modal-backdrop {
          position: fixed; inset: 0; z-index: 50; background: rgba(5,3,8,0.62);
          backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
          display: flex; align-items: center; justify-content: center;
          padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right))
            max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left));
          animation: modal-fade .2s ease forwards;
        }
        @keyframes modal-fade { from { opacity: 0; } to { opacity: 1; } }
        .guest-modal {
          position: relative; width: min(360px, 100%); padding: 28px 24px;
          animation: modal-pop .22s cubic-bezier(.22,1,.36,1) forwards;
        }
        @keyframes modal-pop {
          0% { opacity: 0; transform: scale(0.92) translateY(6px); }
          100% { opacity: 1; transform: scale(1) translateY(0); }
        }
        .guest-modal-close {
          position: absolute; top: 14px; right: 14px; width: 28px; height: 28px; border-radius: 50%;
          background: rgba(255,255,255,0.08); border: none; color: #fff;
          display: flex; align-items: center; justify-content: center; cursor: pointer;
          transition: background .2s ease;
        }
        .guest-modal-close:hover { background: rgba(255,255,255,0.16); }

        button:focus-visible, input:focus-visible, textarea:focus-visible {
          outline: 3px solid var(--accent-a); outline-offset: 2px;
        }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes fade-up { 0% { opacity: 0; transform: translateY(18px); } 100% { opacity: 1; transform: translateY(0); } }

        /* ---- ticket printer ---- */
        .machine-wrap {
          position: relative;
          width: min(84vw, 300px);
          height: 300px;
        }
        .ticket-clip {
          position: absolute; inset: 0; overflow: hidden; z-index: 1;
        }
        /* only fade the top edge while the ticket is still emerging from the slot —
           once it detaches and floats free, it should show at full opacity */
        .ticket-clip-printing {
          mask-image: linear-gradient(to bottom, transparent 0, transparent 10px, black 130px);
          -webkit-mask-image: linear-gradient(to bottom, transparent 0, transparent 10px, black 130px);
        }
        .machine-body {
          position: absolute; left: 0; right: 0; bottom: 0; top: 118px; z-index: 2;
          background: linear-gradient(160deg, #26202E, #14101A);
          border-radius: 0 0 22px 22px;
          padding: 22px 22px 0;
          box-shadow: 0 30px 60px -18px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05);
        }
        .machine-body.machine-shake { animation: machine-shake 0.13s ease-in-out infinite; }
        @keyframes machine-shake {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(1px); }
        }
        .machine-slot-mouth {
          position: absolute; left: 8%; right: 8%; top: 118px; height: 10px; z-index: 3;
          border-radius: 999px;
          background: #0A070D;
          box-shadow: inset 0 3px 6px rgba(0,0,0,0.75), 0 1px 0 rgba(255,255,255,0.06);
        }
        .machine-slot-shadow {
          position: absolute; left: 0; right: 0; top: 108px; height: 24px; z-index: 3; pointer-events: none;
          background: linear-gradient(to bottom, transparent, rgba(0,0,0,0.4), transparent);
        }
        .machine-light {
          position: absolute; top: 16px; right: 20px; width: 8px; height: 8px; border-radius: 50%;
          background: var(--accent-a); box-shadow: 0 0 10px 2px var(--accent-a);
          animation: blink 1s ease-in-out infinite;
          transition: background-color 0.5s ease, box-shadow 0.5s ease;
        }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
        .machine-label {
          font-size: 11px; letter-spacing: 2px; text-transform: uppercase; font-weight: 700;
          color: rgba(255,255,255,0.55);
        }

        /* ticket stays perfectly vertical/flat the whole way through — straight
           stutter up out of the slot, no tilt, no skew */
        .ticket-slide {
          position: absolute; left: 50%; top: 112px; z-index: 1;
          transform: translateX(-50%) translateY(0);
        }
        .ticket-printing {
          animation: print-stutter 1.4s steps(9, end) forwards;
        }
        @keyframes print-stutter {
          0%   { transform: translateX(-50%) translateY(0); }
          15%  { transform: translateX(-50%) translateY(-42px); }
          30%  { transform: translateX(-50%) translateY(-96px); }
          38%  { transform: translateX(-50%) translateY(-100px); }
          50%  { transform: translateX(-50%) translateY(-158px); }
          58%  { transform: translateX(-50%) translateY(-163px); }
          70%  { transform: translateX(-50%) translateY(-222px); }
          82%  { transform: translateX(-50%) translateY(-266px); }
          100% { transform: translateX(-50%) translateY(-292px); }
        }

        .ticket-tappable { cursor: pointer; }
        .ticket-tappable:hover .ticket-metal { transform: translateY(-3px) scale(1.02); }

        /* gentle idle float once the ticket has landed and is waiting to be tapped */
        .ticket-floating { animation: soft-float 4.5s ease-in-out infinite; }
        @keyframes soft-float {
          0%, 100% { transform: rotate(0deg) scale(${LAND_SCALE}) translateY(0); }
          50%      { transform: rotate(0deg) scale(${LAND_SCALE}) translateY(-9px); }
        }

        .tap-hint {
          position: fixed; left: 50%; bottom: calc(9% + env(safe-area-inset-bottom)); transform: translateX(-50%);
          z-index: 6; text-align: center; cursor: pointer;
          display: inline-flex; align-items: center; gap: 8px;
          font-size: 14px; font-weight: 700; color: #fff;
          animation: tap-pulse 1.6s ease-in-out infinite;
        }
        @keyframes tap-pulse {
          0%, 100% { opacity: 0.8; transform: translateX(-50%) translateY(0); }
          50% { opacity: 1; transform: translateX(-50%) translateY(-5px); }
        }

        /* ---- the ticket itself: dark metal stub, high-contrast type ---- */
        .ticket-metal {
          --width: min(58vw, 190px);
          container-type: inline-size;
          position: relative;
          width: var(--width);
          border-radius: 16px;
          overflow: hidden;
          padding: 20px 18px;
          background: linear-gradient(155deg, #2A2534 0%, #14111B 60%, #0A0810 100%);
          color: #fff;
          box-shadow: 0 20px 44px -14px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.09);
          transition: transform .25s cubic-bezier(.22,1,.36,1);
        }
        .ticket-metal.ticket-metal-docked { --width: min(78vw, 300px); }

        /* ---- flip-to-photo interaction (docked ticket only) ---- */
        .ticket-flip-outer { display: flex; flex-direction: column; align-items: center; perspective: 1600px; }
        .ticket-flip-card {
          position: relative; width: fit-content; cursor: pointer;
          /* -webkit- prefix required — iOS Safari doesn't reliably honor the unprefixed
             property alone, and without it the 3D space collapses flat, so both faces'
             backface-visibility:hidden stops working and they bleed through each other */
          -webkit-transform-style: preserve-3d; transform-style: preserve-3d;
          transition: transform .7s cubic-bezier(.4,.2,.2,1);
        }
        .ticket-flip-card.is-flipped { transform: rotateY(180deg); }
        .ticket-flip-face {
          backface-visibility: hidden; -webkit-backface-visibility: hidden;
          -webkit-transform: translateZ(0);
        }
        .ticket-flip-front { position: relative; }
        /* back face is absolutely positioned over the front's box — the front stays in
           normal flow so it's what actually gives the card its height */
        .ticket-flip-back {
          position: absolute; inset: 0; transform: rotateY(180deg);
          border-radius: 22px; overflow: hidden;
          background: linear-gradient(155deg, #2A2534 0%, #14111B 60%, #0A0810 100%);
          border: 1px solid rgba(255,255,255,0.09);
          box-shadow: 0 20px 44px -14px rgba(0,0,0,0.6);
          display: flex; align-items: center; justify-content: center;
        }
        .ticket-flip-back img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .ticket-photo-caption {
          position: absolute; left: 0; right: 0; bottom: 0;
          padding: 34px 18px 16px;
          background: linear-gradient(to top, rgba(10,8,14,0.88) 0%, rgba(10,8,14,0.4) 55%, transparent 100%);
          font-family: 'Fraunces', serif; font-weight: 600; font-size: 15.5px; letter-spacing: 0.3px;
          color: #fff; text-align: center;
        }
        .ticket-photo-caption span { color: var(--accent-b); margin: 0 5px; font-style: italic; }
        .ticket-photo-subcaption {
          margin-top: 4px; font-family: 'Plus Jakarta Sans', sans-serif; font-weight: 700;
          font-size: 10.5px; letter-spacing: 1px; text-transform: uppercase; color: rgba(255,255,255,0.5);
        }
        .ticket-photo-fallback {
          display: flex; flex-direction: column; align-items: center; gap: 8px;
          color: rgba(255,255,255,0.35); font-size: 11px; text-align: center; padding: 20px;
        }
        .ticket-flip-hint {
          margin-top: 14px; background: transparent; border: none; cursor: pointer;
          display: flex; align-items: center; gap: 6px; color: rgba(255,255,255,0.5);
          font-family: 'Plus Jakarta Sans', sans-serif; font-size: 12px; font-weight: 700;
          letter-spacing: 0.3px; padding: 4px 8px; transition: color .2s ease;
        }
        .ticket-flip-hint:hover { color: rgba(255,255,255,0.8); }
        .ticket-flip-hint svg { transition: transform .5s cubic-bezier(.4,.2,.2,1); }
        .ticket-flip-card.is-flipped ~ .ticket-flip-hint svg { transform: rotate(180deg); }
        .ticket-metal.ticket-metal-expanded {
          padding: 34px 28px 30px;
          border-radius: 22px;
        }
        .ticket-metal-expanded .ticket-ages { margin-top: 22px; font-size: clamp(48px, 13cqw, 72px); }
        .ticket-metal-expanded .ticket-divider-line { margin: 26px 0; }
        .ticket-metal-expanded .ticket-details { font-size: 14px; }
        .ticket-metal-expanded .ticket-bottom { margin-top: 30px; }
        .ticket-metal-expanded .ticket-qr { width: 66px; height: 66px; }
        .ticket-metal-expanded .ticket-going { font-size: 12px; }
        .ticket-sheen {
          position: absolute; inset: 0; pointer-events: none;
          background: linear-gradient(115deg, transparent 42%, rgba(255,255,255,0.05) 50%, transparent 58%);
        }
        .ticket-eyebrow {
          position: relative; z-index: 1;
          font-size: 10.5px; letter-spacing: 1.4px; font-weight: 800; color: rgba(255,255,255,0.7);
          display: flex; justify-content: space-between; align-items: center; text-transform: uppercase;
        }
        .ticket-admit {
          font-size: 9px; padding: 3px 8px; border-radius: 999px;
          background: linear-gradient(135deg, var(--accent-a), var(--accent-b)); color: #fff; font-weight: 800;
          white-space: nowrap; text-shadow: 0 1px 1px rgba(0,0,0,0.3);
        }
        .ticket-ages {
          position: relative; z-index: 1;
          margin-top: 14px; font-family: 'Fraunces', serif; font-weight: 600; line-height: 1;
          /* cqw (container-query width), not vw — the card's own width already caps out at
             a fixed px value on wide screens (see --width above), but a plain vw font-size
             keeps growing with the viewport past that point, so on desktop the text
             outgrows the card that stopped growing. cqw ties the font to the card's actual
             rendered width instead, so they always scale together. */
          font-size: clamp(38px, 11cqw, 58px);
          display: flex; align-items: baseline; gap: 10px; color: #fff;
        }
        .ticket-ages span { font-size: 0.4em; color: var(--accent-b); transition: color 0.5s ease; }
        .ticket-eyebrow .amp { color: var(--accent-b); }
        .ticket-divider-line {
          position: relative; z-index: 1;
          height: 0; margin: 16px 0; border-top: 1px dashed rgba(255,255,255,0.22);
        }
        .ticket-details {
          position: relative; z-index: 1;
          font-size: 12.5px; font-weight: 700; letter-spacing: 0.4px; color: rgba(255,255,255,0.88); line-height: 1.6;
        }
        .ticket-countdown {
          position: relative; z-index: 1;
          margin-top: 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.6px;
          color: rgba(255,255,255,0.5); font-variant-numeric: tabular-nums;
        }
        .ticket-countdown span { color: #fff; font-weight: 800; font-size: 13px; }
        .ticket-metal-expanded .ticket-countdown { font-size: 12.5px; margin-top: 16px; }
        .ticket-metal-expanded .ticket-countdown span { font-size: 15px; }

        .ticket-bottom {
          position: relative; z-index: 1;
          margin-top: 18px; display: flex; align-items: flex-end; justify-content: space-between; gap: 10px;
        }
        .ticket-qr {
          display: grid; gap: 1.5px; width: 50px; height: 50px;
          background: #fff; padding: 4px; border-radius: 6px; flex-shrink: 0;
        }
        .ticket-qr span { background: #0A0810; border-radius: 0.5px; }
        .ticket-going {
          font-size: 10.5px; font-weight: 800; letter-spacing: 0.5px; color: var(--accent-b); text-align: right;
          transition: color 0.5s ease;
        }

        .page-content {
          position: relative; z-index: 1; max-width: 560px; margin: 0 auto;
          padding: max(40px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right))
            calc(80px + env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
          display: flex; flex-direction: column; align-items: center;
          animation: fade-up 0.6s cubic-bezier(.22,1,.36,1) forwards;
        }
        .ticket-docked-wrap { margin-bottom: 28px; }

        /* ---- boot / loading screen ---- */
        .boot-overlay {
          position: fixed; inset: 0; z-index: 100;
          background: linear-gradient(165deg, #17131c 0%, #0c090f 100%);
          display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px;
          transition: opacity ${BOOT_FADE_MS}ms ease;
        }
        .boot-overlay.boot-fade { opacity: 0; pointer-events: none; }

        .boot-scene { position: relative; width: 190px; height: 160px; }

        /* the bottle pivots at its own base (transform-origin: bottom center) —
           tilting -50deg swings the neck up and over so it lands directly above
           the (centered) glass, which is why the bottle itself sits off to the
           right and higher up rather than centered/adjacent to the glass */
        .boot-bottle {
          position: absolute; left: 133px; top: 50px; width: 28px; height: 68px;
          transform-origin: 50% 100%;
          animation: bottle-tip ${POUR_MS}ms ease-in-out forwards;
        }
        @keyframes bottle-tip {
          0%   { transform: rotate(0deg); }
          10%  { transform: rotate(-50deg); }
          80%  { transform: rotate(-50deg); }
          92%  { transform: rotate(0deg); }
          100% { transform: rotate(0deg); }
        }
        .boot-bottle-body {
          position: absolute; bottom: 0; left: 0; width: 100%; height: 68%;
          background: linear-gradient(160deg, rgba(140,105,50,0.95), rgba(60,42,16,0.98));
          border-radius: 6px 6px 4px 4px; border: 1px solid rgba(255,255,255,0.16);
        }
        .boot-bottle-neck {
          position: absolute; top: 0; left: 32%; width: 36%; height: 34%;
          background: linear-gradient(160deg, rgba(140,105,50,0.95), rgba(60,42,16,0.98));
          border-radius: 3px 3px 0 0; border: 1px solid rgba(255,255,255,0.16);
        }

        .boot-stream {
          position: absolute; left: 93px; top: 74px;
          width: 4px; height: 0; border-radius: 2px; opacity: 0;
          background: linear-gradient(to bottom, #FFD98A, #E7A93D);
          animation: stream-flow ${POUR_MS}ms ease-in-out forwards;
        }
        @keyframes stream-flow {
          /* the glass is empty at first, so the stream reaches all the way down
             to the bottom (62px); as the fill rises to meet it, the visible
             stream shortens up to 26px — where the final liquid surface sits */
          0%, 9%    { height: 0; opacity: 0; }
          11%       { height: 62px; opacity: 1; }
          80%       { height: 26px; opacity: 1; }
          84%, 100% { height: 0; opacity: 0; }
        }

        .boot-glass {
          position: absolute; left: 76px; top: 90px;
          width: 38px; height: 46px; overflow: hidden;
          background: rgba(255,255,255,0.04);
          border: 2px solid rgba(255,255,255,0.38); border-top: none;
          border-radius: 3px 3px 11px 11px;
        }
        .boot-glass-fill {
          position: absolute; bottom: 0; left: 0; width: 100%; height: 0%;
          background: linear-gradient(180deg, #FFD98A, #D98C2B);
          border-radius: 0 0 9px 9px;
          animation: glass-fill ${POUR_MS}ms ease-in-out forwards;
        }
        @keyframes glass-fill {
          0%, 10% { height: 0%; }
          80%     { height: 78%; }
          100%    { height: 78%; }
        }

        .boot-label {
          font-family: 'Plus Jakarta Sans', sans-serif; font-size: 12.5px; font-weight: 700;
          letter-spacing: 1.6px; text-transform: uppercase; color: rgba(255,255,255,0.5);
          animation: boot-label-pulse 1.4s ease-in-out infinite;
        }
        @keyframes boot-label-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }

        .boot-skip {
          position: absolute; top: max(18px, env(safe-area-inset-top));
          right: max(18px, env(safe-area-inset-right));
          background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.2);
          border-radius: 999px; padding: 7px 16px; font-family: 'Plus Jakarta Sans', sans-serif;
          font-size: 12px; font-weight: 700; letter-spacing: 0.4px; color: rgba(255,255,255,0.75);
          cursor: pointer; transition: background .2s ease, color .2s ease, border-color .2s ease;
        }
        .boot-skip:hover { background: rgba(255,255,255,0.14); color: #fff; border-color: rgba(255,255,255,0.34); }
        .boot-skip:active { transform: scale(0.96); }

        @media (prefers-reduced-motion: reduce) {
          * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
        }
      `}</style>

      {booting &&
        // portaled straight to <body>, outside .inv-root's overflow:hidden — an ancestor
        // with overflow:hidden clips position:fixed descendants in Safari, which would
        // otherwise cut the corner-anchored skip button off near the screen edge
        createPortal(
          <div className={`boot-overlay ${bootFading ? "boot-fade" : ""}`}>
            <div className="boot-scene">
              <div className="boot-bottle">
                <div className="boot-bottle-neck" />
                <div className="boot-bottle-body" />
              </div>
              <div className="boot-stream" />
              <div className="boot-glass">
                <div className="boot-glass-fill" />
              </div>
            </div>
            <div className="boot-label">Pouring up the baijiu…</div>
            <button type="button" className="boot-skip" onClick={skipBoot}>
              Skip
            </button>
          </div>,
          document.body
        )}

      <div className="party-bg">
        <span style={{ width: 440, height: 440, top: "4%", left: "6%", backgroundColor: "var(--glow-a)" }} />
        <span style={{ width: 400, height: 400, bottom: "2%", right: "4%", backgroundColor: "var(--glow-b)", animationDelay: "5.5s" }} />
        <span style={{ width: 320, height: 320, top: "42%", left: "50%", backgroundColor: "var(--glow-a)", animationDelay: "10.5s" }} />
      </div>

      <div style={{ position: "relative", zIndex: 1 }}>
        {/* PRINTER / TICKET STAGE */}
        {showIntro && (
          <div
            style={{
              minHeight: "100dvh",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              paddingTop: "max(24px, env(safe-area-inset-top))",
              paddingBottom: "calc(24px + env(safe-area-inset-bottom))",
              paddingLeft: "max(24px, env(safe-area-inset-left))",
              paddingRight: "max(24px, env(safe-area-inset-right))",
              gap: 40,
            }}
          >
            <div className="machine-wrap">
              <div className={`ticket-clip ${showMachine ? "ticket-clip-printing" : ""}`}>
                <div
                  ref={ticketRef}
                  className={`ticket-slide ${stage === "printing" ? "ticket-printing" : ""} ${
                    ticketInteractive ? "ticket-tappable ticket-floating" : ""
                  }`}
                  style={flightStyle || undefined}
                  onClick={ticketInteractive ? claimTicket : undefined}
                >
                  <TicketCard going={headcount} />
                </div>
              </div>
              {showMachine && (
                <>
                  <div className="machine-slot-shadow" />
                  <div className="machine-slot-mouth" />
                  <div className={`machine-body ${stage === "printing" ? "machine-shake" : ""}`}>
                    <div className="machine-light" />
                    <div className="machine-label">SEPT 19 • CHARLOTTE</div>
                  </div>
                </>
              )}
            </div>

            {showMachine && (
              <>
                <button
                  onClick={printTicket}
                  className="pill-btn pill-primary"
                  disabled={stage === "printing"}
                  style={{
                    padding: "15px 32px",
                    fontSize: 15,
                    letterSpacing: 0.3,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  {stage === "printing" ? (
                    <>
                      <Loader2 size={17} style={{ animation: "spin 1s linear infinite" }} /> Printing...
                    </>
                  ) : (
                    <>
                      <TicketIcon size={17} /> Get Your Pass
                    </>
                  )}
                </button>
                <div className="serif" style={{ fontSize: 16, opacity: 0.9, fontStyle: "italic", textAlign: "center" }}>
                  Alex &amp; Kylie are turning 26 &amp; 23.
                </div>
              </>
            )}
          </div>
        )}

        {stage === "landed" && (
          <div className="tap-hint" onClick={claimTicket}>
            <TicketIcon size={16} /> Tap to claim your ticket
          </div>
        )}

        {/* MAIN PAGE — the ticket stays the centerpiece */}
        {showPage && !showAlbum && (
          <div className="page-content">
            <div className="ticket-docked-wrap">
              <TicketCard going={headcount} docked expanded />
            </div>

            {/* above the RSVP form on purpose — it explains what Day Hang / Dinner /
                Night Outing are, which guests need before ticking the attending boxes */}
            <div style={{ display: "flex", gap: 10, width: "100%" }}>
              <button
                className="pill-btn ghost-btn"
                style={{ flex: 1, padding: "12px 10px", fontSize: 13, justifyContent: "center", whiteSpace: "nowrap" }}
                onClick={() => setShowItinerary(true)}
              >
                <Calendar size={15} /> Itinerary
              </button>
              <button
                className="pill-btn ghost-btn"
                style={{ flex: 1, padding: "12px 10px", fontSize: 13, justifyContent: "center", whiteSpace: "nowrap" }}
                onClick={downloadInviteIcs}
              >
                <CalendarPlus size={15} /> Add to Calendar
              </button>
            </div>

            <button
              className="pill-btn ghost-btn"
              style={{ width: "100%", marginTop: 10, padding: "12px 10px", fontSize: 13, justifyContent: "center" }}
              onClick={handleAlbumClick}
            >
              {albumUnlocked || hasCachedAdminCode() ? <Images size={15} /> : <Lock size={13} />} Photo Album
            </button>

            <div className="glass-panel" style={{ padding: "30px 26px", width: "100%", marginTop: 24 }}>
              <div className="serif" style={{ fontSize: 21, marginBottom: 4, fontWeight: 600 }}>
                RSVP below:
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--muted)", marginBottom: 20, flexWrap: "wrap" }}>
                <Calendar size={13} /> Sat, Sept 19, 2026
                <MapPin size={13} style={{ marginLeft: 8 }} /> {CITY}
              </div>

              {submitted ? (
                <div style={{ textAlign: "center", padding: "18px 0" }}>
                  <div
                    style={{
                      width: 46,
                      height: 46,
                      borderRadius: "50%",
                      background: "linear-gradient(135deg, var(--accent-a), var(--accent-b))",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      margin: "0 auto 12px",
                    }}
                  >
                    <Check size={20} color="#fff" />
                  </div>
                  <div style={{ fontWeight: 800, fontSize: 17 }}>You're on the list</div>
                  <div className="serif" style={{ fontSize: 16, marginTop: 6, color: "var(--muted)", fontStyle: "italic" }}>
                    see you on the 19th
                  </div>
                  <button
                    className="pill-btn pill-primary"
                    style={{ marginTop: 18, padding: "10px 22px", fontSize: 14 }}
                    onClick={() => setSubmitted(false)}
                  >
                    RSVP someone else
                  </button>
                </div>
              ) : (
                <form onSubmit={handleSubmit} style={{ display: "grid", gap: 14 }}>
                  <input
                    className="field"
                    placeholder="Your name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={60}
                  />
                  <div>
                    <label style={{ fontSize: 11.5, opacity: 0.6, display: "block", marginBottom: 6, letterSpacing: 0.4, fontWeight: 700 }}>
                      STATUS
                    </label>
                    <div className="status-group">
                      <div
                        className="status-slider"
                        style={{
                          transform: `translateX(${
                            status === "going" ? 0 : status === "maybe" ? 100 : 200
                          }%)`,
                        }}
                      />
                      <button
                        type="button"
                        className={`status-chip ${status === "going" ? "active" : ""}`}
                        onClick={() => setStatus("going")}
                      >
                        I'm in
                      </button>
                      <button
                        type="button"
                        className={`status-chip ${status === "maybe" ? "active" : ""}`}
                        onClick={() => setStatus("maybe")}
                      >
                        Maybe
                      </button>
                      <button
                        type="button"
                        className={`status-chip ${status === "declined" ? "active" : ""}`}
                        onClick={() => setStatus("declined")}
                      >
                        Can't go
                      </button>
                    </div>
                  </div>

                  {status !== "declined" && (
                    <div>
                      <label style={{ fontSize: 11.5, opacity: 0.6, display: "block", marginBottom: 6, letterSpacing: 0.4, fontWeight: 700 }}>
                        ATTENDING
                      </label>
                      <div style={{ display: "flex", gap: 8 }}>
                        {EVENTS.map((ev) => (
                          <button
                            key={ev.key}
                            type="button"
                            className={`event-chip ${attending.includes(ev.key) ? "active" : ""}`}
                            onClick={() => toggleAttending(ev.key)}
                          >
                            <span className="event-chip-check">
                              {attending.includes(ev.key) && <Check size={11} strokeWidth={3} />}
                            </span>
                            {ev.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <textarea
                    className="field"
                    placeholder="Leave a note for the birthday duo (optional)"
                    rows={2}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={200}
                    style={{ resize: "none" }}
                  />
                  {error && <div style={{ color: "#FF7A9A", fontSize: 13, fontWeight: 700 }}>{error}</div>}
                  <button
                    type="submit"
                    className="pill-btn pill-primary"
                    disabled={submitting}
                    style={{
                      padding: "14px",
                      borderRadius: 14,
                      fontSize: 15.5,
                      display: "flex",
                      justifyContent: "center",
                      alignItems: "center",
                      gap: 8,
                      marginTop: 4,
                    }}
                  >
                    {submitting ? <Loader2 size={17} style={{ animation: "spin 1s linear infinite" }} /> : null}
                    {submitting ? "Saving..." : "Send RSVP"}
                  </button>
                </form>
              )}
            </div>

            <div ref={guestListRef} className="glass-panel" style={{ padding: "26px 26px 30px", width: "100%", marginTop: 24, scrollMarginTop: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 18 }}>
                <div
                  className="serif"
                  style={{ fontSize: 19, fontWeight: 600, cursor: "default", userSelect: "none" }}
                  onClick={handleSecretTap}
                >
                  Who's coming
                </div>
                {!loadingGuests && (
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 800,
                      color: activeTabInfo.color,
                      background: `${activeTabInfo.color}24`,
                      border: `1px solid ${activeTabInfo.color}66`,
                      padding: "4px 10px",
                      borderRadius: 999,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {guestTabCounts[guestTab]} {activeTabInfo.key === "going" ? "confirmed" : activeTabInfo.label.toLowerCase()}
                  </span>
                )}
              </div>

              {loadingGuests ? (
                <div style={{ opacity: 0.85, fontSize: 13.5, display: "flex", alignItems: "center", gap: 8 }}>
                  <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> loading guest list...
                </div>
              ) : guests.length === 0 ? (
                <div className="serif" style={{ fontSize: 16, fontStyle: "italic", opacity: 0.9 }}>
                  Nobody's RSVP'd yet — be the first.
                </div>
              ) : (
                <>
                  <div className="guest-tabs">
                    {GUEST_TABS.map((tab) => (
                      <button
                        key={tab.key}
                        type="button"
                        className={`guest-tab ${guestTab === tab.key ? "guest-tab-active" : ""}`}
                        style={guestTab === tab.key ? { borderColor: `${tab.color}66`, background: `${tab.color}1c`, color: "#fff" } : undefined}
                        onClick={() => setGuestTab(tab.key)}
                      >
                        <span className="guest-tab-dot" style={{ background: tab.color }} />
                        {tab.label}
                        <span className="guest-tab-count">{guestTabCounts[tab.key]}</span>
                      </button>
                    ))}
                  </div>

                  {activeGuestGroup.length > 0 ? (
                    <GuestGroup
                      items={activeGuestGroup}
                      dotColor={activeTabInfo.color}
                      onSelect={setSelectedGuest}
                      onLongPress={handleLongPressGuest}
                    />
                  ) : (
                    <div style={{ opacity: 0.7, fontSize: 13.5, padding: "6px 2px" }}>Nobody here yet.</div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {showPage && showAlbum && (
          <PhotoAlbumScreen
            photos={photos}
            loading={loadingPhotos}
            myDeviceId={getDeviceId()}
            onUpload={handlePhotoUpload}
            onDelete={handlePhotoDelete}
            onBack={() => setShowAlbum(false)}
          />
        )}

        {selectedGuest && <GuestModal guest={selectedGuest} onClose={() => setSelectedGuest(null)} />}
        {showItinerary && (
          <ItineraryModal
            items={itinerary}
            loading={loadingItinerary}
            onAddEvent={handleAddEventClick}
            onLongPressEvent={handleLongPressEvent}
            onClose={() => setShowItinerary(false)}
          />
        )}
        {showAlbumLocked && (
          <AlbumLockedModal onEnterCode={handleAlbumUnlockWithCode} onClose={() => setShowAlbumLocked(false)} />
        )}
        {adminGuest && (
          <AdminGuestModal
            guest={adminGuest}
            onSave={handleAdminSave}
            onDelete={handleAdminDelete}
            onClose={() => setAdminGuest(null)}
          />
        )}
        {(showAddEvent || adminEvent) && (
          <EventFormModal
            item={adminEvent}
            onSave={handleEventSave}
            onDelete={adminEvent ? handleEventDelete : undefined}
            onClose={() => {
              setShowAddEvent(false);
              setAdminEvent(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

function TicketCard({ going = 0, docked = false, expanded = false }) {
  const left = useCountdown(EVENT_DATE);
  const [flipped, setFlipped] = useState(false);
  const [photoMissing, setPhotoMissing] = useState(false);
  // only the docked ticket on the claimed page flips — the bare one is still mid-animation
  const flippable = docked && expanded;

  const front = (
    <div className={`ticket-metal ${docked ? "ticket-metal-docked" : ""} ${expanded ? "ticket-metal-expanded" : ""}`}>
      <div className="ticket-sheen" />
      <div className="ticket-eyebrow">
        <span>Alex <span className="amp">&amp;</span> Kylie</span>
        <span className="ticket-admit">Admit One</span>
      </div>
      <div className="ticket-ages">
        26<span>&amp;</span>23
      </div>
      <div className="ticket-divider-line" />
      <div className="ticket-details">
        SAT, SEPT 19, 2026
        <br />
        {CITY.toUpperCase()}
      </div>
      {left && (
        <div className="ticket-countdown">
          <span>{left.days}</span>d <span>{left.hours}</span>h <span>{left.minutes}</span>m{" "}
          <span>{left.seconds}</span>s
        </div>
      )}
      <div className="ticket-bottom">
        <FauxQR />
        <div className="ticket-going">{going} GOING</div>
      </div>
    </div>
  );

  if (!flippable) return front;

  return (
    <div className="ticket-flip-outer">
      <div
        className={`ticket-flip-card ${flipped ? "is-flipped" : ""}`}
        onClick={() => setFlipped((f) => !f)}
        role="button"
        tabIndex={0}
        aria-label="Flip ticket"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setFlipped((f) => !f);
        }}
      >
        <div className="ticket-flip-face ticket-flip-front">{front}</div>
        <div className="ticket-flip-face ticket-flip-back">
          {photoMissing ? (
            <div className="ticket-photo-fallback">
              <Images size={22} style={{ opacity: 0.4 }} />
              add a photo at /us.png
            </div>
          ) : (
            <>
              <img src="/us.png" alt="Alex and Kylie" onError={() => setPhotoMissing(true)} />
              <div className="ticket-photo-caption">
                Alex <span>&amp;</span> Kylie
                <div className="ticket-photo-subcaption">"guess where this was taken"</div>
              </div>
            </>
          )}
        </div>
      </div>
      <button type="button" className="ticket-flip-hint" onClick={() => setFlipped((f) => !f)}>
        <RotateCw size={12} /> Tap to flip
      </button>
    </div>
  );
}

function FauxQR() {
  const SIZE = 9;
  const finderRing = (r, c) => {
    const isRing = r === 0 || r === 2 || c === 0 || c === 2;
    return isRing || (r === 1 && c === 1) ? 1 : 0;
  };
  const cells = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      let on;
      if (r < 3 && c < 3) on = finderRing(r, c);
      else if (r < 3 && c >= SIZE - 3) on = finderRing(r, c - (SIZE - 3));
      else if (r >= SIZE - 3 && c < 3) on = finderRing(r - (SIZE - 3), c);
      else on = (r * 3 + c * 7 + (r % 2) * 5) % 5 < 2 ? 1 : 0;
      cells.push(on);
    }
  }
  return (
    <div className="ticket-qr" style={{ gridTemplateColumns: `repeat(${SIZE}, 1fr)` }}>
      {cells.map((v, i) => (
        <span key={i} style={{ opacity: v ? 1 : 0 }} />
      ))}
    </div>
  );
}

function GuestGroup({ items, dotColor, onSelect, onLongPress }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {items.map((g) => (
        <GuestRow key={g.id} guest={g} dotColor={dotColor} onSelect={onSelect} onLongPress={onLongPress} />
      ))}
    </div>
  );
}

const LONG_PRESS_MS = 600;

function GuestRow({ guest, dotColor, onSelect, onLongPress }) {
  const timer = useRef(null);
  // set when a long-press fires so the click that follows the release doesn't also open
  // the detail modal
  const firedRef = useRef(false);
  const [pressing, setPressing] = useState(false);

  function start() {
    firedRef.current = false;
    setPressing(true);
    timer.current = setTimeout(() => {
      firedRef.current = true;
      setPressing(false);
      onLongPress(guest);
    }, LONG_PRESS_MS);
  }

  function cancel() {
    clearTimeout(timer.current);
    setPressing(false);
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      className={`guest-row ${pressing ? "guest-row-pressing" : ""}`}
      onClick={() => {
        if (firedRef.current) {
          firedRef.current = false;
          return;
        }
        onSelect(guest);
      }}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="dot" style={{ background: dotColor, flexShrink: 0 }} />
      <span className="guest-row-name">{guest.name}</span>
      {guest.attending?.length > 0 && (
        <span className="guest-row-events">
          {EVENTS.filter((ev) => guest.attending.includes(ev.key))
            .map((ev) => ev.icon)
            .join(" ")}
        </span>
      )}
      {guest.note && <span className="guest-row-note">&ldquo;{guest.note}&rdquo;</span>}
      <ChevronRight size={15} className="guest-row-chevron" />
    </button>
  );
}

function GuestModal({ guest, onClose }) {
  return (
    <div className="guest-modal-backdrop" onClick={onClose}>
      <div className="glass-panel guest-modal" onClick={(e) => e.stopPropagation()}>
        <button className="guest-modal-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
        <div className="serif" style={{ fontSize: 21, fontWeight: 600, marginBottom: 8, paddingRight: 24 }}>
          {guest.name}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--muted)", marginBottom: 18 }}>
          <span
            style={{
              fontWeight: 800,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color:
                guest.status === "going"
                  ? "#4ADE80"
                  : guest.status === "maybe"
                  ? "#FBBF24"
                  : "#F87171",
            }}
          >
            {guest.status === "going" ? "Going" : guest.status === "maybe" ? "Maybe" : "Can't go"}
          </span>
        </div>
        {guest.attending?.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
            {EVENTS.filter((ev) => guest.attending.includes(ev.key)).map((ev) => (
              <span
                key={ev.key}
                style={{
                  fontSize: 11.5,
                  fontWeight: 700,
                  padding: "5px 10px",
                  borderRadius: 999,
                  background: "rgba(74,222,128,0.12)",
                  border: "1px solid rgba(74,222,128,0.4)",
                  color: "#fff",
                }}
              >
                {ev.icon} {ev.label}
              </span>
            ))}
          </div>
        )}
        <div
          className={guest.note ? "serif" : ""}
          style={{
            fontSize: 15,
            lineHeight: 1.6,
            fontStyle: "italic",
            opacity: guest.note ? 1 : 0.55,
            color: "#fff",
          }}
        >
          {guest.note ? `“${guest.note}”` : "No note left."}
        </div>
      </div>
    </div>
  );
}

// Host-only view reached by long-pressing a guest row. Lets the RSVP be corrected after
// the fact — someone flipping from Maybe to going, or adding dinner on later.
function AdminGuestModal({ guest, onSave, onDelete, onClose }) {
  const [status, setStatus] = useState(guest.status);
  const [attending, setAttending] = useState(guest.attending || []);
  const [note, setNote] = useState(guest.note || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function toggle(key) {
    setAttending((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  async function save() {
    setBusy(true);
    setErr("");
    try {
      await onSave({ status, attending, note });
    } catch (e) {
      setErr(e instanceof WrongCodeError ? "Wrong code." : "Couldn't save changes.");
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove ${guest.name} from the list? This can't be undone.`)) return;
    setBusy(true);
    setErr("");
    try {
      await onDelete();
    } catch (e) {
      setErr(e instanceof WrongCodeError ? "Wrong code." : "Couldn't remove that guest.");
      setBusy(false);
    }
  }

  return (
    <div className="guest-modal-backdrop" onClick={onClose}>
      <div className="glass-panel guest-modal" onClick={(e) => e.stopPropagation()}>
        <button className="guest-modal-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>

        <div style={{ fontSize: 10.5, letterSpacing: 1.4, fontWeight: 800, opacity: 0.5, textTransform: "uppercase" }}>
          Host view
        </div>
        <div className="serif" style={{ fontSize: 21, fontWeight: 600, margin: "4px 0 18px", paddingRight: 24 }}>
          {guest.name}
        </div>

        <label style={{ fontSize: 11.5, opacity: 0.6, display: "block", marginBottom: 6, letterSpacing: 0.4, fontWeight: 700 }}>
          STATUS
        </label>
        <div className="status-group" style={{ marginBottom: 16 }}>
          <div
            className="status-slider"
            style={{ transform: `translateX(${status === "going" ? 0 : status === "maybe" ? 100 : 200}%)` }}
          />
          <button type="button" className={`status-chip ${status === "going" ? "active" : ""}`} onClick={() => setStatus("going")}>
            Going
          </button>
          <button type="button" className={`status-chip ${status === "maybe" ? "active" : ""}`} onClick={() => setStatus("maybe")}>
            Maybe
          </button>
          <button type="button" className={`status-chip ${status === "declined" ? "active" : ""}`} onClick={() => setStatus("declined")}>
            Can't go
          </button>
        </div>

        {status !== "declined" && (
          <>
            <label style={{ fontSize: 11.5, opacity: 0.6, display: "block", marginBottom: 6, letterSpacing: 0.4, fontWeight: 700 }}>
              ATTENDING
            </label>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              {EVENTS.map((ev) => (
                <button
                  key={ev.key}
                  type="button"
                  className={`event-chip ${attending.includes(ev.key) ? "active" : ""}`}
                  onClick={() => toggle(ev.key)}
                >
                  <span className="event-chip-check">
                    {attending.includes(ev.key) && <Check size={11} strokeWidth={3} />}
                  </span>
                  {ev.label}
                </button>
              ))}
            </div>
          </>
        )}

        <label style={{ fontSize: 11.5, opacity: 0.6, display: "block", marginBottom: 6, letterSpacing: 0.4, fontWeight: 700 }}>
          NOTE
        </label>
        <textarea
          className="field"
          rows={2}
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
          style={{ resize: "none", marginBottom: 16 }}
        />

        {err && <div style={{ color: "#FF7A9A", fontSize: 13, fontWeight: 700, marginBottom: 12 }}>{err}</div>}

        <div style={{ display: "flex", gap: 10 }}>
          <button className="pill-btn pill-primary" disabled={busy} onClick={save} style={{ flex: 1, padding: "12px", borderRadius: 12, fontSize: 14 }}>
            {busy ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : "Save changes"}
          </button>
          <button className="pill-btn danger-btn" disabled={busy} onClick={remove}>
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

function ItineraryModal({ items, loading, onAddEvent, onLongPressEvent, onClose }) {
  return (
    <div className="guest-modal-backdrop" onClick={onClose}>
      <div className="glass-panel guest-modal itinerary-modal" onClick={(e) => e.stopPropagation()}>
        <button className="guest-modal-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>

        <div style={{ textAlign: "center", marginBottom: 22 }}>
          <div style={{ fontSize: 30, marginBottom: 6 }}>🗓️</div>
          <div className="serif" style={{ fontSize: 20, fontWeight: 600 }}>
            Itinerary
          </div>
        </div>

        {loading ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, opacity: 0.8, justifyContent: "center" }}>
            <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> loading...
          </div>
        ) : items.length === 0 ? (
          <div style={{ fontSize: 14.5, color: "var(--muted)", lineHeight: 1.6, textAlign: "center" }}>
            Check back soon!
          </div>
        ) : (
          <div className="itinerary-timeline">
            {sortByTime(items).map((item, i) => (
              <ItineraryRow
                key={item.id}
                item={item}
                color={TIMELINE_COLORS[i % TIMELINE_COLORS.length]}
                onLongPress={onLongPressEvent}
              />
            ))}
          </div>
        )}

        <button className="pill-btn ghost-btn" style={{ marginTop: 22, width: "100%", justifyContent: "center" }} onClick={onAddEvent}>
          <Calendar size={16} /> Add Event
        </button>
      </div>
    </div>
  );
}

function ItineraryRow({ item, color, onLongPress }) {
  const timer = useRef(null);
  const firedRef = useRef(false);
  const [pressing, setPressing] = useState(false);

  function start() {
    firedRef.current = false;
    setPressing(true);
    timer.current = setTimeout(() => {
      firedRef.current = true;
      setPressing(false);
      onLongPress(item);
    }, LONG_PRESS_MS);
  }
  function cancel() {
    clearTimeout(timer.current);
    setPressing(false);
  }
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div
      className={`itinerary-item ${pressing ? "itinerary-item-pressing" : ""}`}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="itinerary-dot" style={{ background: color, boxShadow: `0 0 0 3px ${color}33` }} />
      {(item.time || item.location) && (
        <div className="itinerary-time">
          {formatTime12(item.time)}
          {item.time && item.location && " · "}
          {item.location && `@ ${item.location}`}
        </div>
      )}
      <div className="itinerary-title">{item.title}</div>
      {item.description && <div className="itinerary-desc">{item.description}</div>}
    </div>
  );
}

function AlbumLockedModal({ onEnterCode, onClose }) {
  return (
    <div className="guest-modal-backdrop" onClick={onClose}>
      <div className="glass-panel guest-modal" style={{ maxWidth: 340, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
        <button className="guest-modal-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
        <div
          style={{
            width: 46, height: 46, borderRadius: "50%", margin: "4px auto 16px",
            background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <Lock size={18} style={{ opacity: 0.8 }} />
        </div>
        <div className="serif" style={{ fontSize: 19, fontWeight: 600, marginBottom: 8 }}>
          Photo album is locked
        </div>
        <div style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.6, marginBottom: 22 }}>
          It unlocks for everyone on the day of the party. Got the host code? You can jump in early.
        </div>
        <button
          className="pill-btn ghost-btn"
          style={{ width: "100%", justifyContent: "center" }}
          onClick={onEnterCode}
        >
          Enter Host Code
        </button>
      </div>
    </div>
  );
}

async function saveSelectedPhotos(chosenPhotos) {
  const files = await Promise.all(
    chosenPhotos.map(async (p, i) => {
      const res = await fetch(p.url);
      const blob = await res.blob();
      const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
      return new File([blob], `alex-and-kylie-${i + 1}.${ext}`, { type: blob.type });
    })
  );

  // the real "save multiple to Photos" experience on iOS/Android — the OS share sheet
  // offers a direct save-all action for a multi-file image share. Falls back to a plain
  // zip download wherever that isn't available (mainly desktop browsers).
  if (navigator.canShare && navigator.canShare({ files })) {
    await navigator.share({ files });
  } else {
    downloadBlob(await filesToZipBlob(files), "alex-and-kylie-photos.zip");
  }
}

function PhotoAlbumScreen({ photos, loading, myDeviceId, onUpload, onDelete, onBack }) {
  const [uploadProgress, setUploadProgress] = useState(null); // { done, total } while a batch is in flight
  const [error, setError] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const [albumView, setAlbumView] = useState("cards"); // "cards" | "grid"
  // files picked but not yet uploaded — each one gets a quick optional caption step first
  const [captionQueue, setCaptionQueue] = useState([]);
  const [captionBatchTotal, setCaptionBatchTotal] = useState(0);
  const fileInputRef = useRef(null);

  function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // lets the same file be picked again later
    if (files.length === 0) return;
    setError("");
    setCaptionQueue(files);
    setCaptionBatchTotal(files.length);
  }

  async function handleConfirmCaption(title, caption) {
    const [file, ...rest] = captionQueue;
    setUploadProgress({ done: 0, total: 1 });
    try {
      await onUpload(file, title, caption);
    } catch {
      setError("Upload failed");
    } finally {
      setUploadProgress(null);
      setCaptionQueue(rest);
      if (rest.length === 0) setCaptionBatchTotal(0);
    }
  }

  function handleCancelQueue() {
    setCaptionQueue([]);
    setCaptionBatchTotal(0);
  }

  async function handleSkipAllCaptions() {
    const remaining = captionQueue;
    let failures = 0;
    for (let i = 0; i < remaining.length; i++) {
      setUploadProgress({ done: i, total: remaining.length });
      try {
        await onUpload(remaining[i], "", "");
      } catch {
        failures++;
      }
    }
    setUploadProgress(null);
    setCaptionQueue([]);
    setCaptionBatchTotal(0);
    if (failures > 0) {
      setError(failures === remaining.length ? "Upload failed" : `${failures} of ${remaining.length} photos failed to upload`);
    }
  }

  function toggleSelectMode() {
    setSelectMode((prev) => !prev);
    setSelected(new Set());
    setError("");
  }

  function toggleSelected(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSaveSelected() {
    setError("");
    setSaving(true);
    try {
      await saveSelectedPhotos(photos.filter((p) => selected.has(p.id)));
      setSelectMode(false);
      setSelected(new Set());
    } catch (err) {
      if (err?.name !== "AbortError") setError("Couldn't save those photos — try again");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="album-topbar">
        <button type="button" className="album-topbar-btn" onClick={onBack}>
          <ArrowLeft size={15} /> Back
        </button>
        {!loading && photos.length > 0 && (
          <button type="button" className="album-topbar-btn" onClick={toggleSelectMode}>
            {selectMode ? (
              <>
                <X size={13} /> Cancel
              </>
            ) : (
              <>
                <CheckSquare size={13} /> Select
              </>
            )}
          </button>
        )}
      </div>

      <div className="page-content album-screen">
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          <div style={{ fontSize: 30, marginBottom: 6 }}>📸</div>
          <div className="serif" style={{ fontSize: 22, fontWeight: 600 }}>
            Photo Album
          </div>
        </div>

        {loading ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, opacity: 0.8, justifyContent: "center" }}>
            <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> loading...
          </div>
        ) : photos.length === 0 ? (
          <div style={{ fontSize: 14.5, color: "var(--muted)", lineHeight: 1.6, textAlign: "center" }}>
            No photos yet — be the first to add one.
          </div>
        ) : (
          <>
            <div className="album-view-toggle">
              <button
                type="button"
                className={albumView === "cards" ? "active" : ""}
                onClick={() => setAlbumView("cards")}
              >
                Cards
              </button>
              <span className="album-view-divider" />
              <button
                type="button"
                className={albumView === "grid" ? "active" : ""}
                onClick={() => setAlbumView("grid")}
              >
                Grid
              </button>
            </div>

            <div className={albumView === "cards" ? "album-list" : "album-grid"}>
              {photos.map((p) => (
                <div
                  key={p.id}
                  className={`album-card ${selectMode ? "photo-tile-selectable" : ""} ${
                    selectMode && selected.has(p.id) ? "photo-tile-selected" : ""
                  }`}
                  onClick={selectMode ? () => toggleSelected(p.id) : undefined}
                >
                  <img src={p.url} alt="" loading="lazy" />
                  {albumView === "cards" && (p.title || p.caption) && (
                    <div className="ticket-photo-caption">
                      {p.title || " "}
                      {p.caption && <div className="ticket-photo-subcaption">"{p.caption}"</div>}
                    </div>
                  )}
                  {selectMode ? (
                    <span className="photo-select-mark">{selected.has(p.id) && <Check size={15} />}</span>
                  ) : (
                    p.deviceId === myDeviceId && (
                      <button
                        type="button"
                        className="photo-delete"
                        onClick={() => onDelete(p)}
                        aria-label="Delete photo"
                      >
                        <Trash2 size={14} />
                      </button>
                    )
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {error && (
          <div style={{ color: "#F87171", fontSize: 13, marginTop: 14, textAlign: "center" }}>{error}</div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={handleFiles}
        />

      </div>

      {/* portaled to <body> — .page-content's own "fade-up" mount animation leaves a
          `transform` on it via animation-fill-mode: forwards, and per spec any ancestor
          with a transform becomes the containing block for position:fixed descendants.
          Left inside .page-content, this button would pin itself to that shrink-wrapped
          content box instead of the real viewport corner. */}
      {/* hidden while the caption modal is up — its own "Add Photo" button covers that job */}
      {captionQueue.length === 0 &&
        createPortal(
          selectMode ? (
            <div className="album-select-bar">
              <span style={{ fontSize: 12.5, color: "var(--muted)", whiteSpace: "nowrap" }}>{selected.size} selected</span>
              <button
                className="pill-btn pill-primary"
                style={{ padding: "10px 20px", fontSize: 13, display: "inline-flex", alignItems: "center", gap: 7 }}
                disabled={selected.size === 0 || saving}
                onClick={handleSaveSelected}
              >
                {saving ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : <Share2 size={15} />}
                Save {selected.size > 0 ? selected.size : ""}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="album-fab"
              disabled={!!uploadProgress}
              onClick={() => fileInputRef.current?.click()}
              aria-label="Add photos"
            >
              {uploadProgress ? (
                <Loader2 size={24} style={{ animation: "spin 1s linear infinite" }} />
              ) : (
                <Plus size={29} />
              )}
            </button>
          ),
          document.body
        )}

      {captionQueue.length > 0 && (
        <PhotoCaptionModal
          key={captionQueue[0].name + captionQueue[0].lastModified}
          file={captionQueue[0]}
          index={captionBatchTotal - captionQueue.length + 1}
          total={captionBatchTotal}
          uploading={!!uploadProgress}
          uploadProgress={uploadProgress}
          onConfirm={handleConfirmCaption}
          onCancelAll={handleCancelQueue}
          onSkipAll={handleSkipAllCaptions}
        />
      )}
    </>
  );
}

function PhotoCaptionModal({ file, index, total, uploading, uploadProgress, onConfirm, onCancelAll, onSkipAll }) {
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    setTitle("");
    setCaption("");
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <div className="guest-modal-backdrop" onClick={uploading ? undefined : onCancelAll}>
      <div className="glass-panel guest-modal" onClick={(e) => e.stopPropagation()}>
        {!uploading && (
          <button className="guest-modal-close" onClick={onCancelAll} aria-label="Cancel">
            <X size={16} />
          </button>
        )}

        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div className="serif" style={{ fontSize: 18, fontWeight: 600 }}>
            {total > 1 ? `Add caption (${index} of ${total})` : "Add a caption"}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>optional — leave blank to skip</div>
        </div>

        <div className="album-card" style={{ marginBottom: 16 }}>
          {previewUrl && <img src={previewUrl} alt="" />}
          {(title || caption) && (
            <div className="ticket-photo-caption">
              {title || " "}
              {caption && <div className="ticket-photo-subcaption">"{caption}"</div>}
            </div>
          )}
        </div>

        <div style={{ display: "grid", gap: 10, marginBottom: 18 }}>
          <input
            className="field"
            placeholder="Title (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={60}
            disabled={uploading}
          />
          <input
            className="field"
            placeholder="Caption (optional)"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            maxLength={100}
            disabled={uploading}
          />
        </div>

        <button
          className="pill-btn pill-primary"
          style={{ width: "100%", padding: "13px 0", fontSize: 14.5 }}
          disabled={uploading}
          onClick={() => onConfirm(title.trim(), caption.trim())}
        >
          {uploading ? (
            <Loader2 size={17} style={{ animation: "spin 1s linear infinite" }} />
          ) : title || caption ? (
            "Add Photo"
          ) : (
            "Add Without Caption"
          )}
        </button>

        {total > 1 && (
          <button type="button" className="photo-skip-all" disabled={uploading} onClick={onSkipAll}>
            {uploading ? (
              <>
                <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
                Uploading {uploadProgress?.done ?? 0}/{uploadProgress?.total ?? total}...
              </>
            ) : (
              <>
                <SkipForward size={13} />
                Skip captions for all {total - index + 1} remaining
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function TimePicker({ value, onChange }) {
  const { hour12, minute, meridiem } = time24ToParts(value);
  const set = (h, m, mer) => onChange(partsToTime24(h, m, mer));

  return (
    <div className="time-picker">
      <select
        className="time-picker-select"
        value={hour12}
        onChange={(e) => set(Number(e.target.value), minute, meridiem)}
        aria-label="Hour"
      >
        {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      <span className="time-picker-colon">:</span>
      <select
        className="time-picker-select"
        value={minute}
        onChange={(e) => set(hour12, Number(e.target.value), meridiem)}
        aria-label="Minute"
      >
        {MINUTE_STEPS.map((m) => (
          <option key={m} value={m}>
            {String(m).padStart(2, "0")}
          </option>
        ))}
      </select>
      <div className="meridiem-toggle">
        <div
          className="meridiem-slider"
          style={{ transform: `translateX(${meridiem === "AM" ? 0 : 100}%)` }}
        />
        <button
          type="button"
          className={meridiem === "AM" ? "active" : ""}
          onClick={() => set(hour12, minute, "AM")}
        >
          AM
        </button>
        <button
          type="button"
          className={meridiem === "PM" ? "active" : ""}
          onClick={() => set(hour12, minute, "PM")}
        >
          PM
        </button>
      </div>
    </div>
  );
}

// Shared create/edit form — create mode when `item` is omitted.
function EventFormModal({ item, onSave, onDelete, onClose }) {
  const [title, setTitle] = useState(item?.title || "");
  const [time, setTime] = useState(item?.time || DEFAULT_TIME_24);
  const [location, setLocation] = useState(item?.location || "");
  const [description, setDescription] = useState(item?.description || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save(e) {
    e.preventDefault();
    if (!title.trim()) {
      setErr("Event name is required");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await onSave({ title: title.trim(), time, location: location.trim(), description: description.trim() });
    } catch (e) {
      setErr(e instanceof WrongCodeError ? "Wrong code." : "Couldn't save the event.");
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove "${item.title}" from the itinerary?`)) return;
    setBusy(true);
    setErr("");
    try {
      await onDelete();
    } catch (e) {
      setErr(e instanceof WrongCodeError ? "Wrong code." : "Couldn't remove that event.");
      setBusy(false);
    }
  }

  return (
    <div className="guest-modal-backdrop" onClick={onClose}>
      <div className="glass-panel guest-modal" onClick={(e) => e.stopPropagation()}>
        <button className="guest-modal-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>

        <div style={{ fontSize: 10.5, letterSpacing: 1.4, fontWeight: 800, opacity: 0.5, textTransform: "uppercase" }}>
          Host view
        </div>
        <div className="serif" style={{ fontSize: 21, fontWeight: 600, margin: "4px 0 18px", paddingRight: 24 }}>
          {item ? "Edit Event" : "Add Event"}
        </div>

        <form onSubmit={save} style={{ display: "grid", gap: 14 }}>
          <input
            className="field"
            placeholder="Event name"
            value={title}
            maxLength={60}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div>
            <label style={{ fontSize: 11.5, opacity: 0.6, display: "block", marginBottom: 6, letterSpacing: 0.4, fontWeight: 700 }}>
              TIME
            </label>
            <TimePicker value={time} onChange={setTime} />
          </div>
          <input
            className="field"
            placeholder="@ Location"
            value={location}
            maxLength={80}
            onChange={(e) => setLocation(e.target.value)}
          />
          <textarea
            className="field"
            placeholder="Description (optional)"
            rows={3}
            value={description}
            maxLength={300}
            onChange={(e) => setDescription(e.target.value)}
            style={{ resize: "none" }}
          />

          {err && <div style={{ color: "#FF7A9A", fontSize: 13, fontWeight: 700 }}>{err}</div>}

          <div style={{ display: "flex", gap: 10 }}>
            <button type="submit" className="pill-btn pill-primary" disabled={busy} style={{ flex: 1, padding: "12px", borderRadius: 12, fontSize: 14 }}>
              {busy ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : item ? "Save changes" : "Add event"}
            </button>
            {item && (
              <button type="button" className="pill-btn danger-btn" disabled={busy} onClick={remove}>
                Remove
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
