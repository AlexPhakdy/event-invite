import { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { MapPin, Calendar, Check, Loader2, Ticket as TicketIcon, X, ChevronRight } from "lucide-react";
import { fetchGuests, addGuest, clearGuests } from "./api.js";

const FALL_MS = 900;
const CLAIM_MS = 320;
const LAND_SCALE = 1.5;
const POUR_MS = 5000;
const BOOT_FADE_MS = 500;

const EVENTS = [
  { key: "day", label: "Day Hang", icon: "☀️" },
  { key: "dinner", label: "Dinner", icon: "🍽️" },
  { key: "night", label: "Night Outing", icon: "🌙" },
];

export default function BirthdayInvite() {
  // idle -> printing -> falling -> landed -> claiming -> claimed
  const [stage, setStage] = useState("idle");
  const [flightStyle, setFlightStyle] = useState(null);
  const ticketRef = useRef(null);
  const [guests, setGuests] = useState([]);
  const [loadingGuests, setLoadingGuests] = useState(true);
  const [name, setName] = useState("");
  const [status, setStatus] = useState("going");
  const [attending, setAttending] = useState([]);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [selectedGuest, setSelectedGuest] = useState(null);
  const [showItinerary, setShowItinerary] = useState(false);
  const secretTaps = useRef({ count: 0, timer: null });
  const guestListRef = useRef(null);

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
      if (window.confirm("Clear the entire guest list? This can't be undone.")) {
        (async () => {
          try {
            await clearGuests();
            setGuests([]);
          } catch (e) {
            // ignore — nothing to clear if storage isn't reachable
          }
        })();
      }
    }
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

        .guest-row {
          display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
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
        .ticket-metal.ticket-metal-expanded {
          padding: 34px 28px 30px;
          border-radius: 22px;
        }
        .ticket-metal-expanded .ticket-ages { margin-top: 22px; font-size: clamp(48px, 13vw, 72px); }
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
          font-size: clamp(38px, 11vw, 58px);
          display: flex; align-items: baseline; gap: 10px; color: #fff;
        }
        .ticket-ages span { font-size: 0.4em; color: var(--accent-a); transition: color 0.5s ease; }
        .ticket-divider-line {
          position: relative; z-index: 1;
          height: 0; margin: 16px 0; border-top: 1px dashed rgba(255,255,255,0.22);
        }
        .ticket-details {
          position: relative; z-index: 1;
          font-size: 12.5px; font-weight: 700; letter-spacing: 0.4px; color: rgba(255,255,255,0.88); line-height: 1.6;
        }
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

        @media (prefers-reduced-motion: reduce) {
          * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
        }
      `}</style>

      {booting && (
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
        </div>
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
        {showPage && (
          <div className="page-content">
            <div className="ticket-docked-wrap">
              <TicketCard going={headcount} docked expanded />
            </div>

            <div className="glass-panel" style={{ padding: "30px 26px", width: "100%", marginTop: 24 }}>
              <div className="serif" style={{ fontSize: 21, marginBottom: 4, fontWeight: 600 }}>
                RSVP below:
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--muted)", marginBottom: 20 }}>
                <Calendar size={13} /> Sat, Sept 19, 2026
                <MapPin size={13} style={{ marginLeft: 8 }} /> Charlotte, NC
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
                      color: "#4ADE80",
                      background: "rgba(74,222,128,0.14)",
                      border: "1px solid rgba(74,222,128,0.4)",
                      padding: "4px 10px",
                      borderRadius: 999,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {headcount} confirmed
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
                <div style={{ display: "grid", gap: 22 }}>
                  {going.length > 0 && (
                    <GuestGroup title="Going" items={going} dotColor="#4ADE80" onSelect={setSelectedGuest} />
                  )}
                  {maybe.length > 0 && (
                    <GuestGroup title="Maybe" items={maybe} dotColor="#FBBF24" onSelect={setSelectedGuest} />
                  )}
                  {declined.length > 0 && (
                    <GuestGroup title="Can't make it" items={declined} dotColor="rgba(255,255,255,0.4)" onSelect={setSelectedGuest} />
                  )}
                </div>
              )}
            </div>

            <button
              className="pill-btn"
              onClick={() => setShowItinerary(true)}
              style={{
                marginTop: 26,
                padding: "12px 24px",
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.2)",
                color: "#fff",
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontSize: 14,
              }}
            >
              <Calendar size={16} /> See Itinerary
            </button>
          </div>
        )}

        {selectedGuest && <GuestModal guest={selectedGuest} onClose={() => setSelectedGuest(null)} />}
        {showItinerary && <ItineraryModal onClose={() => setShowItinerary(false)} />}
      </div>
    </div>
  );
}

function TicketCard({ going = 0, docked = false, expanded = false }) {
  return (
    <div className={`ticket-metal ${docked ? "ticket-metal-docked" : ""} ${expanded ? "ticket-metal-expanded" : ""}`}>
      <div className="ticket-sheen" />
      <div className="ticket-eyebrow">
        Alex &amp; Kylie
        <span className="ticket-admit">Admit One</span>
      </div>
      <div className="ticket-ages">
        26<span>&amp;</span>23
      </div>
      <div className="ticket-divider-line" />
      <div className="ticket-details">
        SAT, SEPT 19, 2026
        <br />
        CHARLOTTE, NC
      </div>
      <div className="ticket-bottom">
        <FauxQR />
        <div className="ticket-going">{going} GOING</div>
      </div>
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

function GuestGroup({ title, items, dotColor, onSelect }) {
  return (
    <div>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10, fontWeight: 800, opacity: 0.9 }}>
        {title}
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {items.map((g) => (
          <button key={g.id} className="guest-row" onClick={() => onSelect(g)}>
            <span className="dot" style={{ background: dotColor, flexShrink: 0 }} />
            <span className="guest-row-name">{g.name}</span>
            {g.attending?.length > 0 && (
              <span className="guest-row-events">
                {EVENTS.filter((ev) => g.attending.includes(ev.key))
                  .map((ev) => ev.icon)
                  .join(" ")}
              </span>
            )}
            {g.note && <span className="guest-row-note">&ldquo;{g.note}&rdquo;</span>}
            <ChevronRight size={15} className="guest-row-chevron" />
          </button>
        ))}
      </div>
    </div>
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
                  : "rgba(255,255,255,0.55)",
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

function ItineraryModal({ onClose }) {
  return (
    <div className="guest-modal-backdrop" onClick={onClose}>
      <div className="glass-panel guest-modal" onClick={(e) => e.stopPropagation()} style={{ textAlign: "center" }}>
        <button className="guest-modal-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
        <div style={{ fontSize: 34, marginBottom: 10 }}>🗓️</div>
        <div className="serif" style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>
          Itinerary
        </div>
        <div style={{ fontSize: 14.5, color: "var(--muted)", lineHeight: 1.6 }}>
          Check back soon!
        </div>
      </div>
    </div>
  );
}
