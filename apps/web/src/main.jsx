import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid,
  ResponsiveContainer, Tooltip, XAxis, YAxis
} from "recharts";
import {
  AlertTriangle, BarChart3, BedDouble, Bell, CalendarDays, Camera,
  Check, CheckCircle, ChevronRight, DoorOpen, Dumbbell, FileDown,
  Globe, Hotel, LogOut, Menu, MessageSquare, Monitor, Navigation, PhoneCall,
  Plus, QrCode, Send, Settings, ShieldCheck, Sparkles, Star, Truck,
  Upload, Users, X, XCircle, Zap, ZoomIn
} from "lucide-react";
import { io } from "socket.io-client";
import { t, LANGUAGES } from "./lib/i18n.js";
import { findPath } from "./lib/dijkstra.js";
import "./styles.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:4000";

// ── hooks ─────────────────────────────────────────────────────────────────────

function useApi() {
  const [token, setToken] = useState(localStorage.getItem("zynloc_token") || "");
  function hdrs(extra = {}) {
    return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
  }
  async function request(path, opts = {}) {
    const res = await fetch(`${API}${path}`, { ...opts, headers: hdrs(opts.headers || {}) });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      // Auto-clear stale JWT so the login page is shown immediately
      if (res.status === 401) { localStorage.removeItem("zynloc_token"); setToken(""); }
      throw new Error(b.error || `HTTP ${res.status}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }
  function saveToken(t) { localStorage.setItem("zynloc_token", t); setToken(t); }
  function logout() { localStorage.removeItem("zynloc_token"); setToken(""); }
  return { token, request, saveToken, logout };
}

function useToast() {
  const [toast, setToast] = useState(null);
  function show(msg, type = "info") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }
  return { toast, show };
}

// ── utils ─────────────────────────────────────────────────────────────────────

function fmtDate(v) { return v ? new Date(v).toLocaleDateString() : "—"; }
function fmtTime(v) { return v ? new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"; }
function cap(s) { return s ? String(s).replace(/[-_](\w)/g, (_, c) => " " + c.toUpperCase()).replace(/^\w/, c => c.toUpperCase()) : ""; }

// ── shared ────────────────────────────────────────────────────────────────────

function Toast({ toast }) {
  if (!toast) return null;
  return <div className={`toast ${toast.type || "info"}`}>{toast.msg}</div>;
}

function Modal({ open, onClose, children }) {
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><X size={18} /></button>
        {children}
      </div>
    </div>
  );
}

function QrBlock({ dataUrl, label, caption }) {
  function download() {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${label || "qr"}.png`;
    a.click();
  }
  if (!dataUrl) return <div className="qr-placeholder"><QrCode size={40} /><p>{label || "Generating…"}</p></div>;
  return (
    <div className="qr-block">
      {label && <p className="qr-label">{label}</p>}
      <img src={dataUrl} alt="QR code" className="qr-image" />
      {caption && <p className="qr-caption">{caption}</p>}
      <button className="ghost sm" onClick={download}><FileDown size={14} /> Download</button>
    </div>
  );
}

function Metric({ label, value }) {
  return <div className="metric"><strong>{value}</strong><span>{label}</span></div>;
}

function GoldAreaChart({ data, dataKey, xKey }) {
  return (
    <div className="chart">
      <ResponsiveContainer>
        <AreaChart data={data}>
          <defs>
            <linearGradient id="goldFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#d8a84f" stopOpacity={0.65} />
              <stop offset="95%" stopColor="#d8a84f" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#243044" />
          <XAxis dataKey={xKey} stroke="#9aa6b2" />
          <YAxis stroke="#9aa6b2" />
          <Tooltip contentStyle={{ background: "#0f1923", border: "1px solid #243044", color: "#e8d5a3" }} />
          <Area type="monotone" dataKey={dataKey} stroke="#d8a84f" fill="url(#goldFill)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function GoldBarChart({ data }) {
  return (
    <div className="chart">
      <ResponsiveContainer>
        <BarChart data={data}>
          <CartesianGrid stroke="#243044" />
          <XAxis dataKey="name" stroke="#9aa6b2" />
          <YAxis stroke="#9aa6b2" />
          <Tooltip contentStyle={{ background: "#0f1923", border: "1px solid #243044", color: "#e8d5a3" }} />
          <Bar dataKey="revenue" fill="#d8a84f" radius={[8, 8, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function GridPage({ form, children }) {
  return (
    <section className="panel">
      <div className="form-bar">{form}</div>
      <div className="cards">{children}</div>
    </section>
  );
}

// ── SelfieCapture ─────────────────────────────────────────────────────────────
// Uses ONLY a native file input — no getUserMedia, no webcam API.
// <input type="file" accept="image/*" capture="user"> opens the front camera
// directly on iOS and Android without any permission handling needed.
// FileReader converts the picked file to a base64 data-URL immediately.

function SelfieCapture({ onCapture, label = "Take selfie", hint = "" }) {
  const inputRef = useRef(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);

  const INPUT_ID = "selfie-file-input";

  function handleChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    const reader = new FileReader();

    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      if (!dataUrl || typeof dataUrl !== "string") {
        console.error("[SelfieCapture] FileReader returned empty result");
        setLoading(false);
        return;
      }
      console.log("[SelfieCapture] photo read OK, length=", dataUrl.length);
      setPreview(dataUrl);   // show preview immediately
      setLoading(false);
      onCapture(dataUrl);    // persist to parent state immediately
    };

    reader.onerror = (ev) => {
      console.error("[SelfieCapture] FileReader error", ev);
      setLoading(false);
    };

    reader.readAsDataURL(file);
  }

  function handleRetake(e) {
    e.preventDefault();
    setPreview(null);
    onCapture(null);
    // Reset value so onChange fires again even if same file is selected
    if (inputRef.current) inputRef.current.value = "";
    // Re-open the picker — this is within a user gesture so it works on mobile
    setTimeout(() => inputRef.current?.click(), 30);
  }

  return (
    <div className="selfie-capture">
      {/* Single hidden input — always present so the label can target it */}
      <input
        ref={inputRef}
        id={INPUT_ID}
        type="file"
        accept="image/*"
        capture="user"
        onChange={handleChange}
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden", pointerEvents: "none" }}
      />

      {/* ── Idle: label triggers the input (no JS onClick needed) ── */}
      {!preview && !loading && (
        <div className="selfie-prompt">
          <label htmlFor={INPUT_ID} className="selfie-trigger-btn">
            <Camera size={20} />
            <span>{label}</span>
          </label>
          {hint && <p className="muted selfie-hint">{hint}</p>}
        </div>
      )}

      {/* ── Reading file ── */}
      {loading && (
        <p className="muted selfie-hint">Saving photo…</p>
      )}

      {/* ── Preview — stays visible until retake ── */}
      {preview && !loading && (
        <div className="selfie-done">
          <img className="selfie-img" src={preview} alt="Your photo" />
          <p className="selfie-saved-msg">✓ Photo saved — tap Continue below</p>
          <button type="button" className="ghost selfie-retake-btn" onClick={handleRetake}>
            <Camera size={14} /> Retake
          </button>
        </div>
      )}
    </div>
  );
}

// ── ImageUpload ───────────────────────────────────────────────────────────────
// Drag-drop or click-to-upload image input.
// Resizes to maxWidth using canvas, returns base64 JPEG via onChange(dataUrl).

function ImageUpload({ value, onChange, label = "Upload image", maxWidth = 1200 }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  function processFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxWidth) { height = Math.round(height * maxWidth / width); width = maxWidth; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        onChange(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  }

  function onDrop(e) { e.preventDefault(); setDragging(false); processFile(e.dataTransfer.files[0]); }
  function onDragOver(e) { e.preventDefault(); setDragging(true); }

  return (
    <div
      className={`img-upload ${dragging ? "dragging" : ""} ${value ? "has-img" : ""}`}
      onDragOver={onDragOver} onDragLeave={() => setDragging(false)} onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      role="button" tabIndex={0}
      onKeyDown={e => e.key === "Enter" && inputRef.current?.click()}
    >
      <input ref={inputRef} type="file" accept="image/*" style={{ display: "none" }}
        onChange={e => processFile(e.target.files[0])} />
      {value ? (
        <div className="img-upload-preview">
          <img src={value} alt={label} />
          <div className="img-upload-overlay"><Camera size={18} /><span>Change photo</span></div>
        </div>
      ) : (
        <div className="img-upload-placeholder">
          <Upload size={28} />
          <span className="img-upload-label">{label}</span>
          <span className="img-upload-hint">Click or drag &amp; drop · JPG / PNG / WEBP</span>
        </div>
      )}
    </div>
  );
}

// ── ZoomImg ───────────────────────────────────────────────────────────────────
// Wraps any <img> to make it tappable/clickable for fullscreen lightbox view.

function ZoomImg({ src, alt = "", className = "", block = false }) {
  const [open, setOpen] = useState(false);
  if (!src) return null;
  return (
    <div className={`zoom-wrap${block ? " zoom-wrap-block" : ""}`} onClick={() => setOpen(true)}>
      <img src={src} alt={alt} className={className} />
      <div className="zoom-badge"><ZoomIn size={12} /></div>
      {open && createPortal(
        <div className="lightbox-overlay" onClick={() => setOpen(false)}>
          <img src={src} alt={alt} className="lightbox-img" onClick={e => e.stopPropagation()} />
          <button className="lightbox-close" onClick={() => setOpen(false)}>
            <X size={22} />
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

// ── QrScanner ─────────────────────────────────────────────────────────────────
// MOBILE (Android/iPhone/Samsung): nimiq/qr-scanner — live continuous video,
//   no photo needed, works on Samsung AND iPhone Safari.
// DESKTOP: guest search box — no camera needed.
// Worker file: public/qr-scanner-worker.min.js (copied from node_modules).

function QrScanner({ onScan, onClose, bookings = [] }) {
  const videoRef    = useRef(null);
  const scannerRef  = useRef(null);
  const stoppedRef  = useRef(false);
  const libRef      = useRef(null);
  // All state hoisted above conditionals — React Rules of Hooks
  const [error,  setError]  = useState(null);
  const [search, setSearch] = useState("");
  const isIphone  = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isMobile  = isIphone || isAndroid;

  // ── iPhone only: start live scanner on mount ────────────────────────────
  useEffect(() => {
    if (!isIphone) return;           // Android uses native camera; desktop uses search
    if (!videoRef.current) return;

    stoppedRef.current = false;

    const startScanner = async () => {
      try {
        const { default: QrScannerLib } = await import("qr-scanner");
        libRef.current = QrScannerLib;
        if (stoppedRef.current) return;

        // Step 1 — Raw getUserMedia first — Samsung Chrome requires this before
        // ANY camera enumeration or QrScannerLib initialization works.
        const tempStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } }
        });
        tempStream.getTracks().forEach(t => t.stop()); // stop immediately — permission only
        if (stoppedRef.current) return;

        // Step 2 — Enumerate cameras now that labels are populated
        const cameras = await QrScannerLib.listCameras(false);

        // Step 3 — Score cameras to find best rear camera
        let bestCamera = null;
        if (cameras.length > 0) {
          const scored = cameras.map(cam => {
            const l = (cam.label || "").toLowerCase();
            let score = 0;
            if (l.includes("back") || l.includes("rear") || l.includes("environment")) score += 10;
            if (l.includes("0") && l.includes("camera2")) score += 8;
            if (l.includes("ultrawide") || l.includes("wide")) score -= 5;
            if (l.includes("front") || l.includes("user") || l.includes("selfie")) score -= 20;
            return { cam, score };
          });
          scored.sort((a, b) => b.score - a.score);
          bestCamera = scored[0].cam;
        }
        if (stoppedRef.current) return;

        // Step 4 — Create scanner with best camera or fallback
        const scanner = new QrScannerLib(
          videoRef.current,
          (result) => {
            if (!stoppedRef.current) {
              stoppedRef.current = true;
              scanner.stop();
              scanner.destroy();
              onScan(result.data);
            }
          },
          {
            preferredCamera: bestCamera ? bestCamera.id : "environment",
            highlightScanRegion: true,
            highlightCodeOutline: true,
            returnDetailedScanResult: true,
            maxScansPerSecond: 5,
          }
        );

        scannerRef.current = scanner;
        await scanner.start();

      } catch (err) {
        if (stoppedRef.current) return;
        if (err.name === "NotAllowedError") {
          setError("Camera permission denied. Tap the lock icon in your browser address bar, allow camera access, then try again.");
        } else if (err.name === "NotFoundError" || err.message?.includes("camera not found") || err.message?.includes("No camera")) {
          // Last resort — try with no camera preference
          try {
            const QrScannerLib = libRef.current;
            const scanner = new QrScannerLib(
              videoRef.current,
              (result) => {
                if (!stoppedRef.current) {
                  stoppedRef.current = true;
                  scanner.stop();
                  scanner.destroy();
                  onScan(result.data);
                }
              },
              { returnDetailedScanResult: true, maxScansPerSecond: 5 }
            );
            scannerRef.current = scanner;
            await scanner.start();
          } catch (err2) {
            setError("Could not access camera: " + (err2.message || String(err2)));
          }
        } else {
          setError("Camera error: " + (err.message || String(err)));
        }
      }
    };

    startScanner();

    return () => {
      stoppedRef.current = true;
      try { scannerRef.current?.stop(); scannerRef.current?.destroy(); } catch {}
      scannerRef.current = null;
    };
  }, []); // empty deps — runs once on mount, cleaned up on unmount

  function handleClose() {
    stoppedRef.current = true;
    try { scannerRef.current?.stop(); scannerRef.current?.destroy(); } catch {}
    scannerRef.current = null;
    onClose();
  }

  // ── Desktop: guest search ────────────────────────────────────────────────
  if (!isMobile) {
    const filtered = bookings.filter(b =>
      ((b.guest_name  || "").toLowerCase().includes(search.toLowerCase()) ||
       (b.guest_email || "").toLowerCase().includes(search.toLowerCase())) &&
      b.status !== "past" && !b.revoked
    );
    return (
      <div className="qr-scanner-shell">
        <div className="qr-desktop-search">
          <h3 style={{ margin: 0, fontSize: 16 }}>Find Guest</h3>
          <input
            placeholder="Type guest name or email…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
            style={{ width: "100%" }}
          />
          <div className="qr-guest-results">
            {filtered.map(b => (
              <div key={b.id} className="qr-guest-row" onClick={() => onScan(b.qr_token)}>
                {b.selfie_url && <img src={b.selfie_url} className="qr-guest-avatar" alt="" />}
                <div>
                  <div className="qr-guest-name">{b.guest_name}</div>
                  <div className="qr-guest-email">{b.guest_email}</div>
                </div>
              </div>
            ))}
            {search && filtered.length === 0 && (
              <p className="qr-no-results">No matching guests found</p>
            )}
          </div>
          <button className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    );
  }

  // ── Android: native camera instruction ──────────────────────────────────
  // Android guests use their native Samsung/Google camera app — it scans QR
  // codes automatically and opens the URL. No in-browser camera needed.
  if (isAndroid) {
    // Manager context (bookings available) — show search box instead
    if (bookings.length > 0) {
      const filtered = bookings.filter(b =>
        ((b.guest_name  || "").toLowerCase().includes(search.toLowerCase()) ||
         (b.guest_email || "").toLowerCase().includes(search.toLowerCase())) &&
        b.status !== "past" && !b.revoked
      );
      return (
        <div className="qr-scanner-shell">
          <div className="qr-desktop-search">
            <h3 style={{ margin: 0, fontSize: 16 }}>Find Guest</h3>
            <input placeholder="Type guest name or email…" value={search}
              onChange={e => setSearch(e.target.value)} autoFocus style={{ width: "100%" }} />
            <div className="qr-guest-results">
              {filtered.map(b => (
                <div key={b.id} className="qr-guest-row" onClick={() => onScan(b.qr_token)}>
                  {b.selfie_url && <img src={b.selfie_url} className="qr-guest-avatar" alt="" />}
                  <div>
                    <div className="qr-guest-name">{b.guest_name}</div>
                    <div className="qr-guest-email">{b.guest_email}</div>
                  </div>
                </div>
              ))}
              {search && filtered.length === 0 && <p className="qr-no-results">No matching guests found</p>}
            </div>
            <button className="secondary" onClick={onClose}>Cancel</button>
          </div>
        </div>
      );
    }
    // Guest context — show instruction to use native camera
    return (
      <div className="qr-scanner-shell">
        <div className="qr-android-ui">
          <div className="qr-android-icon">📷</div>
          <h3 className="qr-android-title">Use Your Camera App</h3>
          <p className="qr-android-instruction">
            Open your native camera app and point it at the QR code displayed at the hotel.
            Your Samsung camera reads it automatically.
          </p>
          <div className="qr-android-steps">
            <div className="qr-step">1. Press your Home button or swipe up</div>
            <div className="qr-step">2. Open your Camera app</div>
            <div className="qr-step">3. Point at the QR code</div>
            <div className="qr-step">4. Tap the link that appears</div>
          </div>
          <button className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    );
  }

  // ── iPhone: error state — camera failed, offer photo fallback ────────────
  if (error) {
    return (
      <div className="qr-scanner-shell">
        <div className="qr-file-ui">
          <p className="qr-error">{error}</p>
          <p className="qr-hint">Allow camera access when prompted and try again</p>
          <label className="qr-capture-label primary" style={{ marginTop: 12, cursor: "pointer" }}>
            <input type="file" accept="image/*" capture="environment" style={{ display: "none" }}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file || !libRef.current) return;
                try {
                  const result = await libRef.current.scanImage(file, { returnDetailedScanResult: true });
                  onScan(result.data);
                } catch {
                  setError("QR code not detected. Make sure QR fills the frame and is well lit.");
                }
              }} />
            📷 Take Photo Instead
          </label>
          <button className="secondary" onClick={handleClose}>Cancel</button>
        </div>
      </div>
    );
  }

  // ── iPhone: live video view ──────────────────────────────────────────────
  return (
    <div className="qr-scanner-shell">
      <video ref={videoRef} className="qr-video" />
      <div className="qr-hint-overlay">
        <p className="qr-hint">Point camera at QR code — scans automatically</p>
      </div>
      <button className="secondary close-camera" onClick={handleClose}>Cancel</button>
    </div>
  );
}

// ── ScanReceptionPage ─────────────────────────────────────────────────────────
// Shown when Android native camera opens /reception-scan/:scanToken
// Reads guest token from localStorage (saved when guest opened their booking link)

function ScanReceptionPage({ scanToken }) {
  const [status,     setStatus]     = useState("loading"); // loading|waiting|checked-in|revoked|error|no-session
  const [errMsg,     setErrMsg]     = useState("");
  const [roomNumber, setRoomNumber] = useState("");
  const guestToken = localStorage.getItem("zynloc_guest_token");
  const bookingId  = localStorage.getItem("zynloc_booking_id");

  // Step 1 — notify reception via API
  useEffect(() => {
    if (!guestToken) { setStatus("no-session"); return; }
    fetch(`${API}/api/guest/${guestToken}/scan-reception`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receptionToken: scanToken })
    }).then(async r => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Failed");
      setStatus("waiting"); // reception notified — now wait for live confirmation
    }).catch(err => { setStatus("error"); setErrMsg(err.message); });
  }, [scanToken]);

  // Step 2 — Socket.IO: update instantly when manager confirms check-in
  useEffect(() => {
    if (!bookingId || !guestToken) return;
    const socket = io(API, { reconnection: true });
    socket.emit("guest:join", bookingId);
    socket.on("connect",          () => socket.emit("guest:join", bookingId)); // re-join on reconnect
    socket.on("checkin:confirmed", ({ roomNumber: rn }) => { setRoomNumber(rn || ""); setStatus("checked-in"); });
    socket.on("access:revoked",    () => setStatus("revoked"));
    return () => socket.disconnect();
  }, [bookingId]);

  const S = { minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "center",
              justifyContent: "center", padding: 32, flexDirection: "column", gap: 16 };
  const C = { textAlign: "center", maxWidth: 340, display: "flex", flexDirection: "column",
              gap: 12, alignItems: "center" };

  if (status === "loading")    return <main style={S}><p className="muted">Notifying reception…</p></main>;
  if (status === "no-session") return (
    <main style={S}><div style={C}>
      <p style={{ fontSize: 48 }}>🔑</p>
      <h2 style={{ color: "var(--gold)" }}>Open Your Guest Link First</h2>
      <p className="muted">Open your booking email link first, then scan the reception QR again.</p>
    </div></main>
  );
  if (status === "error") return (
    <main style={S}><div style={C}>
      <p style={{ fontSize: 48 }}>❌</p>
      <p className="error">{errMsg}</p>
      {guestToken && <a className="secondary" href={`/guest/${guestToken}`} style={{ textDecoration: "none" }}>Back</a>}
    </div></main>
  );
  if (status === "revoked") return (
    <main style={S}><div style={C}>
      <p style={{ fontSize: 48 }}>⛔</p>
      <h2 style={{ color: "var(--red)" }}>Access Revoked</h2>
      <p className="muted">Please contact the front desk for assistance.</p>
    </div></main>
  );
  if (status === "checked-in") return (
    <main style={{ ...S, background: "var(--bg)" }}><div style={C}>
      <p style={{ fontSize: 80 }}>🎉</p>
      <h2 style={{ color: "var(--green)", fontSize: 28, fontWeight: 800 }}>You Are Checked In!</h2>
      {roomNumber && <p style={{ fontSize: 22, color: "var(--gold)", fontWeight: 700 }}>Room {roomNumber}</p>}
      <p className="muted">Welcome! Your room is ready.</p>
      <a className="primary" href={`/guest/${guestToken}`} style={{ textDecoration: "none", marginTop: 8 }}>
        Go to My Room →
      </a>
    </div></main>
  );
  // waiting
  return (
    <main style={S}><div style={C}>
      <div style={{ width: 56, height: 56, borderRadius: "50%", border: "4px solid var(--border)",
                    borderTopColor: "var(--gold)", animation: "spin .8s linear infinite" }} />
      <h2 style={{ color: "var(--gold)" }}>Reception Notified!</h2>
      <p className="muted">Please wait at the front desk.</p>
      <p className="muted" style={{ fontSize: 12 }}>This screen updates automatically when staff confirm.</p>
    </div></main>
  );
}

// ── ScanFacilityPage ──────────────────────────────────────────────────────────
// Shown when Android native camera opens /facility-scan/:scanToken

function ScanFacilityPage({ scanToken }) {
  const [status,  setStatus]  = useState("loading"); // loading|granted|denied|error|no-session
  const [result,  setResult]  = useState(null);
  const [errMsg,  setErrMsg]  = useState("");
  const guestToken = localStorage.getItem("zynloc_guest_token");

  useEffect(() => {
    if (!guestToken) { setStatus("no-session"); return; }
    fetch(`${API}/api/guest/${guestToken}/facility-scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ facilityToken: scanToken })
    }).then(async r => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Failed");
      setResult(j);
      setStatus(j.result === "access_granted" ? "granted" : "denied");
    }).catch(err => { setStatus("error"); setErrMsg(err.message); });
  }, [scanToken]);

  return (
    <main style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "center",
                   justifyContent: "center", padding: 32, flexDirection: "column", gap: 16 }}>
      {status === "loading" && <p className="muted">Checking access…</p>}

      {status === "no-session" && (
        <div className="stack" style={{ textAlign: "center", maxWidth: 320 }}>
          <p style={{ fontSize: 48 }}>🔑</p>
          <h2 style={{ color: "var(--gold)" }}>Open Your Guest Link First</h2>
          <p className="muted">Please open the booking link from your email, then scan this QR again.</p>
        </div>
      )}

      {status === "granted" && (
        <div className="stack" style={{ textAlign: "center", maxWidth: 320 }}>
          <p style={{ fontSize: 64 }}>✅</p>
          <h2 style={{ color: "var(--green)" }}>Access Granted</h2>
          <p className="muted">{result?.facilityName} — welcome!</p>
          <a className="secondary" href={`/guest/${guestToken}`}
             style={{ textDecoration: "none", marginTop: 8 }}>Back to my room</a>
        </div>
      )}

      {status === "denied" && (
        <div className="stack" style={{ textAlign: "center", maxWidth: 320 }}>
          <p style={{ fontSize: 64 }}>🚫</p>
          <h2 style={{ color: "var(--red)" }}>Access Denied</h2>
          <p className="muted">{result?.facilityName} is not included in your package. Contact reception for assistance.</p>
          <a className="secondary" href={`/guest/${guestToken}`}
             style={{ textDecoration: "none", marginTop: 8 }}>Back to my room</a>
        </div>
      )}

      {status === "error" && (
        <div className="stack" style={{ textAlign: "center", maxWidth: 320 }}>
          <p style={{ fontSize: 48 }}>❌</p>
          <p className="error">{errMsg}</p>
          {guestToken && <a className="secondary" href={`/guest/${guestToken}`}
             style={{ textDecoration: "none", marginTop: 8 }}>Back to my room</a>}
        </div>
      )}
    </main>
  );
}

// ── Router ────────────────────────────────────────────────────────────────────

function App() {
  const api = useApi();
  const parts  = window.location.pathname.split("/").filter(Boolean);
  const params = new URLSearchParams(window.location.search);

  if (parts[0] === "guest"           && parts[1]) return <GuestApp token={parts[1]} />;
  if (parts[0] === "reception-scan"  && parts[1]) return <ScanReceptionPage scanToken={parts[1]} />;
  if (parts[0] === "facility-scan"   && parts[1]) return <ScanFacilityPage  scanToken={parts[1]} />;
  if (parts[0] === "reset-password"  && params.get("token")) {
    return <ResetPassword resetToken={params.get("token")} />;
  }
  if (!api.token) return <Login api={api} />;
  return <ManagerRoot api={api} />;
}

// ── Login ─────────────────────────────────────────────────────────────────────

function Login({ api }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ hotelName: "Zynloc Demo", name: "Hotel Manager", email: "", password: "" });
  const [error, setError] = useState("");
  const [forgotMsg, setForgotMsg] = useState("");
  const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);

  async function submit(e) {
    e.preventDefault();
    setError("");
    try {
      if (mode === "forgot") {
        await fetch(`${API}/api/auth/forgot-password`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: form.email })
        });
        setForgotMsg("If that email exists, a reset link has been sent.");
        return;
      }
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/register-manager";
      const result = await api.request(path, { method: "POST", body: JSON.stringify(form) });
      api.saveToken(result.token);
    } catch (err) { setError(err.message); }
  }

  async function demo() {
    try {
      const r = await api.request("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "manager@zynloc.local", password: "password123" }) });
      api.saveToken(r.token);
    } catch {
      try {
        const r = await api.request("/api/auth/register-manager", { method: "POST", body: JSON.stringify({ hotelName: "Zynloc Demo", name: "Demo Manager", email: "manager@zynloc.local", password: "password123" }) });
        api.saveToken(r.token);
      } catch (err) { setError(err.message); }
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="brand-lockup"><Hotel size={28} /><span>Zynloc Hotel</span></div>
        <h1>{mode === "login" ? "Manager Login" : mode === "register" ? "Create Hotel" : "Reset Password"}</h1>
        {mode === "forgot" && <p className="auth-hint">Enter the email address you use to <strong>log in to Zynloc</strong> — not your email sender address.</p>}
        <form onSubmit={submit} className="stack">
          {mode === "register" && (
            <>
              <input placeholder="Hotel name" value={form.hotelName} onChange={e => setForm({ ...form, hotelName: e.target.value })} />
              <input placeholder="Your name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </>
          )}
          <input type="email" placeholder={mode === "forgot" ? "Your Zynloc login email" : "Email"} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
          {mode !== "forgot" && (
            <input type="password" placeholder="Password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
          )}
          {error && <p className="error">{error}</p>}
          {forgotMsg && <p className="success-text">{forgotMsg}</p>}
          <button className="primary" type="submit">
            <ShieldCheck size={18} />
            {mode === "login" ? "Sign in" : mode === "register" ? "Create account" : "Send reset link"}
          </button>
          {mode === "login" && (
            <button type="button" className="forgot-link" onClick={() => { setMode("forgot"); setError(""); setForgotMsg(""); }}>
              Forgot password?
            </button>
          )}
        </form>
        {isLocal && mode === "login" && <button className="demo-login" onClick={demo}>Open local demo dashboard</button>}
        <button type="button" className="text-button" onClick={() => { setMode(m => m === "login" ? "register" : "login"); setError(""); setForgotMsg(""); }}>
          {mode === "login" ? "Create a hotel account" : mode === "register" ? "Back to login" : "Back to login"}
        </button>
      </section>
    </main>
  );
}

// ── ResetPassword ─────────────────────────────────────────────────────────────

function ResetPassword({ resetToken }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (password !== confirm) { setError("Passwords don't match"); return; }
    setError("");
    try {
      const res = await fetch(`${API}/api/auth/reset-password`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: resetToken, password })
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error || "Invalid or expired link"); return; }
      setDone(true);
      setMsg("Password updated! You can now sign in.");
    } catch { setError("Network error — please try again"); }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="brand-lockup"><Hotel size={28} /><span>Zynloc Hotel</span></div>
        <h1>New Password</h1>
        {done ? (
          <div className="stack">
            <p className="success-text"><CheckCircle size={16} /> {msg}</p>
            <a className="primary" href="/" style={{ textDecoration: "none" }}>Go to login</a>
          </div>
        ) : (
          <form onSubmit={submit} className="stack">
            <input required type="password" placeholder="New password (8+ chars)" value={password} onChange={e => setPassword(e.target.value)} />
            <input required type="password" placeholder="Confirm new password" value={confirm} onChange={e => setConfirm(e.target.value)} />
            {error && <p className="error">{error}</p>}
            <button className="primary" type="submit"><Check size={18} />Set password</button>
          </form>
        )}
      </section>
    </main>
  );
}

// ── Manager Root ──────────────────────────────────────────────────────────────

function ManagerRoot({ api }) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);

  function reload() {
    api.request("/api/settings").then(s => { setSettings(s); setLoading(false); }).catch(() => setLoading(false));
  }

  useEffect(() => { reload(); }, []);

  if (loading) return <div className="center-screen"><p>Loading…</p></div>;
  if (!settings?.onboarding_complete) return <Onboarding api={api} onComplete={reload} />;
  return <ManagerDashboard api={api} initialSettings={settings} />;
}

// ── Onboarding ────────────────────────────────────────────────────────────────

function Onboarding({ api, onComplete }) {
  const [step, setStep] = useState(0);
  const { toast, show } = useToast();
  const STEPS = ["Brand", "Rooms", "Facilities", "Packages", "QR Codes"];

  return (
    <main className="onboarding-shell">
      <div className="onboarding-card">
        <div className="brand-lockup"><Hotel size={26} /><span>Hotel Setup</span></div>
        <div className="wizard-steps">
          {STEPS.map((s, i) => (
            <div key={s} className={`wizard-step ${i === step ? "active" : i < step ? "done" : ""}`}>
              <span>{i < step ? <Check size={13} /> : i + 1}</span>{s}
            </div>
          ))}
        </div>
        {step === 0 && <OnboardBrand api={api} onNext={() => setStep(1)} show={show} />}
        {step === 1 && <OnboardRooms api={api} onNext={() => setStep(2)} show={show} />}
        {step === 2 && <OnboardFacilities api={api} onNext={() => setStep(3)} show={show} />}
        {step === 3 && <OnboardPackages api={api} onNext={() => setStep(4)} show={show} />}
        {step === 4 && <OnboardQrCodes api={api} onComplete={onComplete} show={show} />}
      </div>
      <Toast toast={toast} />
    </main>
  );
}

function OnboardBrand({ api, onNext, show }) {
  const [form, setForm] = useState({ name: "", address: "", logoUrl: "", coverPhotoUrl: "", receptionPhone: "" });
  async function save(e) {
    e.preventDefault();
    try { await api.request("/api/settings", { method: "PUT", body: JSON.stringify(form) }); onNext(); }
    catch (err) { show(err.message, "error"); }
  }
  return (
    <form className="stack" onSubmit={save}>
      <h2>Hotel Brand</h2>
      <p className="muted">Shown in the guest app and confirmation emails.</p>
      <input required placeholder="Hotel name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
      <input placeholder="Address" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
      <input placeholder="Reception phone" value={form.receptionPhone} onChange={e => setForm({ ...form, receptionPhone: e.target.value })} />
      <label className="upload-field-label">Hotel logo</label>
      <ImageUpload value={form.logoUrl} onChange={v => setForm({ ...form, logoUrl: v })} label="Upload logo" maxWidth={400} />
      <label className="upload-field-label">Cover photo</label>
      <ImageUpload value={form.coverPhotoUrl} onChange={v => setForm({ ...form, coverPhotoUrl: v })} label="Upload cover photo" maxWidth={1200} />
      <button className="primary" type="submit"><ChevronRight size={18} />Save and continue</button>
    </form>
  );
}

function OnboardRooms({ api, onNext, show }) {
  const [rooms, setRooms] = useState([]);
  const [form, setForm] = useState({ number: "", type: "double", pricePerNight: 120, imageUrl: "", zone: "" });
  async function add(e) {
    e.preventDefault();
    try {
      const r = await api.request("/api/rooms", { method: "POST", body: JSON.stringify(form) });
      setRooms(prev => [...prev, r]);
      setForm(f => ({ ...f, number: "", imageUrl: "" }));
      show(`Room ${r.number} added`, "success");
    } catch (err) { show(err.message, "error"); }
  }
  return (
    <div className="stack">
      <h2>Add Rooms</h2>
      <p className="muted">Add at least one room. More can be added later.</p>
      <form className="stack" onSubmit={add}>
        <div className="inline-form">
          <input required placeholder="Room number" value={form.number} onChange={e => setForm({ ...form, number: e.target.value })} />
          <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
            {["single","double","suite","villa"].map(x => <option key={x}>{x}</option>)}
          </select>
          <input type="number" placeholder="$/night" value={form.pricePerNight} onChange={e => setForm({ ...form, pricePerNight: +e.target.value })} />
        </div>
        <label className="upload-field-label">Room photo (optional)</label>
        <ImageUpload value={form.imageUrl} onChange={v => setForm({ ...form, imageUrl: v })} label="Upload room photo" maxWidth={800} />
        <button className="primary" type="submit"><Plus size={18} />Add room</button>
      </form>
      <div className="cards">
        {rooms.map(r => (
          <article className="room-card" key={r.id}>
            <ZoomImg src={r.image_url} alt={`Room ${r.number}`} block />
            <div><BedDouble size={15} /><h3>{r.number}</h3><p>{r.type} · ${r.price_per_night}/night</p></div>
          </article>
        ))}
      </div>
      <button className="primary" disabled={!rooms.length} onClick={rooms.length ? onNext : undefined}>
        <ChevronRight size={18} />Continue
      </button>
    </div>
  );
}

function OnboardFacilities({ api, onNext, show }) {
  const [facilities, setFacilities] = useState([]);
  const [form, setForm] = useState({ name: "", icon: "Star", zone: "" });
  const ICONS = ["Star","Dumbbell","Waves","Utensils","Car","Wifi","Coffee","Zap"];
  async function add(e) {
    e.preventDefault();
    try {
      const f = await api.request("/api/facilities", { method: "POST", body: JSON.stringify(form) });
      setFacilities(prev => [...prev, f]);
      setForm(x => ({ ...x, name: "" }));
      show(`${f.name} added`, "success");
    } catch (err) { show(err.message, "error"); }
  }
  return (
    <div className="stack">
      <h2>Add Facilities</h2>
      <p className="muted">Pool, gym, restaurant, spa… skip and add later if needed.</p>
      <form className="inline-form" onSubmit={add}>
        <input required placeholder="Facility name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <select value={form.icon} onChange={e => setForm({ ...form, icon: e.target.value })}>
          {ICONS.map(i => <option key={i}>{i}</option>)}
        </select>
        <input placeholder="Zone (e.g. Floor 1)" value={form.zone} onChange={e => setForm({ ...form, zone: e.target.value })} />
        <button className="primary" type="submit"><Plus size={18} />Add</button>
      </form>
      <div className="cards">
        {facilities.map(f => <article className="card" key={f.id}><Dumbbell size={18} /><h3>{f.name}</h3><p>{f.zone || "—"}</p></article>)}
      </div>
      <button className="primary" onClick={onNext}><ChevronRight size={18} />Continue</button>
    </div>
  );
}

function OnboardPackages({ api, onNext, show }) {
  const [facilities, setFacilities] = useState([]);
  const [packages, setPackages] = useState([]);
  const [form, setForm] = useState({ name: "", description: "", price: 0, facilityIds: [] });

  useEffect(() => { api.request("/api/facilities").then(setFacilities).catch(() => {}); }, []);

  async function add(e) {
    e.preventDefault();
    try {
      const p = await api.request("/api/packages", { method: "POST", body: JSON.stringify(form) });
      setPackages(prev => [...prev, p]);
      setForm({ name: "", description: "", price: 0, facilityIds: [] });
      show(`Package "${p.name}" added`, "success");
    } catch (err) { show(err.message, "error"); }
  }

  function toggle(id) {
    setForm(f => ({
      ...f,
      facilityIds: f.facilityIds.includes(id) ? f.facilityIds.filter(x => x !== id) : [...f.facilityIds, id]
    }));
  }

  return (
    <div className="stack">
      <h2>Create Packages</h2>
      <p className="muted">Packages bundle facilities. Assign a package when creating a booking.</p>
      <form className="stack" onSubmit={add}>
        <input required placeholder="Package name (e.g. All-Inclusive)" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <input placeholder="Description" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
        <input type="number" placeholder="Add-on price ($)" value={form.price} onChange={e => setForm({ ...form, price: +e.target.value })} />
        <div className="check-list">
          {facilities.map(f => (
            <label key={f.id}>
              <input type="checkbox" checked={form.facilityIds.includes(f.id)} onChange={() => toggle(f.id)} />{f.name}
            </label>
          ))}
        </div>
        <button className="primary" type="submit"><Plus size={18} />Add package</button>
      </form>
      <div className="cards">
        {packages.map(p => <article className="card" key={p.id}><Star size={18} /><h3>{p.name}</h3><p>${p.price}</p></article>)}
      </div>
      <button className="primary" onClick={onNext}><ChevronRight size={18} />Continue to QR codes</button>
    </div>
  );
}

function OnboardQrCodes({ api, onComplete, show }) {
  const [facilityQrs, setFacilityQrs] = useState([]);
  const [checkoutQr, setCheckoutQr] = useState(null);
  const [loading, setLoading] = useState(false);

  async function generate() {
    setLoading(true);
    try {
      const [fqrs, settings] = await Promise.all([
        api.request("/api/settings/facility-qrs"),
        api.request("/api/settings")
      ]);
      setFacilityQrs(fqrs);
      setCheckoutQr(settings.checkout_qr);
    } catch (err) { show(err.message, "error"); }
    setLoading(false);
  }

  async function finish() {
    try {
      await api.request("/api/settings", { method: "PUT", body: JSON.stringify({ onboardingComplete: true }) });
      onComplete();
    } catch (err) { show(err.message, "error"); }
  }

  return (
    <div className="stack">
      <h2>Print Your QR Codes</h2>
      <p className="muted">Facility QRs go at each entrance. The checkout QR goes at the front desk.</p>
      {!facilityQrs.length ? (
        <button className="primary" onClick={generate} disabled={loading}>
          <QrCode size={18} />{loading ? "Generating…" : "Generate QR codes"}
        </button>
      ) : (
        <>
          <div className="qr-print-grid">
            {facilityQrs.map(f => <QrBlock key={f.facility_id} dataUrl={f.qr_data_url} label={f.facility_name} />)}
            {checkoutQr && <QrBlock dataUrl={checkoutQr} label="Checkout QR" caption="Place at front desk" />}
          </div>
          <button className="ghost" onClick={() => window.print()}>Print all QR codes</button>
          <button className="primary" onClick={finish}><Check size={18} />Done — Open Dashboard</button>
        </>
      )}
    </div>
  );
}

// ── Manager Dashboard ─────────────────────────────────────────────────────────

function ManagerDashboard({ api, initialSettings }) {
  const [active, setActive] = useState(() => {
    // restore last tab from hash on hard-reload
    const hash = window.location.hash.replace("#", "");
    const valid = ["overview","rooms","bookings","guests","facilities","packages",
      "service-requests","access-log","messages","staff","analytics","settings","alerts"];
    return valid.includes(hash) ? hash : "overview";
  });
  const [me, setMe] = useState(null);
  const [data, setData] = useState({
    rooms: [], bookings: [], guests: [], facilities: [], packages: [],
    messages: [], notifications: [], analytics: null, settings: initialSettings,
    staff: [], accessLog: [], serviceRequests: [],
    alerts: { unresolved: [], resolved: [] },
  });
  const [sessionCount,    setSessionCount]    = useState(1);
  const [socketConnected, setSocketConnected] = useState(false);
  const [menuOpen,        setMenuOpen]        = useState(false);
  const { toast, show } = useToast();

  const NAV = [
    ["overview", BarChart3, "Overview"],
    ["alerts", Bell, "Alerts"],
    ["rooms", BedDouble, "Rooms"],
    ["bookings", CalendarDays, "Bookings"],
    ["guests", Users, "Guests"],
    ["facilities", Dumbbell, "Facilities"],
    ["packages", Star, "Packages"],
    ["service-requests", Truck, "Service Requests"],
    ["access-log", ShieldCheck, "Access Log"],
    ["messages", MessageSquare, "Messages"],
    ["staff", Users, "Staff"],
    ["analytics", BarChart3, "Analytics"],
    ["settings", Settings, "Settings"],
  ];

  const BOTTOM_NAV = [
    ["overview",  BarChart3,     "Overview"],
    ["bookings",  CalendarDays,  "Bookings"],
    ["guests",    Users,         "Guests"],
    ["messages",  MessageSquare, "Messages"],
    ["alerts",    Bell,          "Alerts"],
  ];

  // History-aware navigation — enables browser back/forward
  function navigate(key) {
    setActive(key);
    window.history.pushState({ mgrTab: key }, "", `#${key}`);
  }

  // Sync browser back/forward with active tab
  useEffect(() => {
    window.history.replaceState({ mgrTab: active }, "", `#${active}`);
    const onPop = e => {
      const tab = e.state?.mgrTab || "overview";
      setActive(tab);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  async function loadAll() {
    const settled = await Promise.allSettled([
      api.request("/api/auth/me"),
      api.request("/api/rooms"),
      api.request("/api/bookings"),
      api.request("/api/guests"),
      api.request("/api/facilities"),
      api.request("/api/packages"),
      api.request("/api/messages"),
      api.request("/api/notifications"),
      api.request("/api/analytics"),
      api.request("/api/settings"),
      api.request("/api/staff"),
      api.request("/api/access-log"),
      api.request("/api/service-requests"),
      api.request("/api/alerts"),
    ]);
    const v = i => settled[i].status === "fulfilled" ? settled[i].value : null;
    setMe(v(0));
    setData({
      rooms: v(1) || [], bookings: v(2) || [], guests: v(3) || [],
      facilities: v(4) || [], packages: v(5) || [],
      messages: v(6) || [], notifications: v(7) || [],
      analytics: v(8), settings: v(9), staff: v(10) || [],
      accessLog: v(11) || [], serviceRequests: v(12) || [],
      alerts: v(13) || { unresolved: [], resolved: [] },
    });
  }

  useEffect(() => {
    loadAll().catch(() => api.logout());
    // 10-second safety-net poll — catches anything Socket.IO missed
    const interval = setInterval(() => { loadAllRef.current(); }, 10_000);
    return () => clearInterval(interval);
  }, []);

  // Stable ref so socket callbacks always call the latest loadAll without stale closure
  const loadAllRef = useRef(loadAll);
  useEffect(() => { loadAllRef.current = loadAll; });

  useEffect(() => {
    if (!me?.hotel_id) return;
    const hotelId = me.hotel_id;
    const doLoad = () => loadAllRef.current();
    const socket = io(API, { reconnection: true });
    // Re-join + re-fetch on every (re)connect so Render restarts don't break sync
    socket.on("connect", () => {
      socket.emit("hotel:join", hotelId);
      setSocketConnected(true);
      doLoad(); // re-fetch on reconnect — catches anything missed while disconnected
    });
    socket.on("disconnect", () => setSocketConnected(false));
    socket.emit("hotel:join", hotelId);
    ["rooms:changed","bookings:changed","messages:new","notifications:new",
     "service-requests:new","service-requests:changed","new:alert"].forEach(ev => socket.on(ev, doLoad));
    socket.on("access:denied", ev => show(`Access denied: ${ev.guestName} at ${ev.facilityName}`, "warning"));
    socket.on("guest:arrived", ev => {
      doLoad();
      show(`${ev.guestName} has arrived at reception!`, "success");
    });
    // BUG 2: listen for live session count from server
    socket.on("hotel:session_count", ({ count }) => setSessionCount(count));
    return () => socket.disconnect();
  }, [me?.hotel_id]);

  const occupied = data.rooms.filter(r => r.status === "occupied").length;
  const occupancy = data.rooms.length ? Math.round(occupied / data.rooms.length * 100) : 0;
  const revenue = Math.round((data.analytics?.revenueByRoom || []).reduce((s, r) => s + Number(r.revenue || 0), 0));
  const activeLabel = NAV.find(([k]) => k === active)?.[2] || cap(active);
  const totalUnreadMessages = Array.isArray(data.messages)
    ? data.messages.filter(m => m.sender === "guest" && !m.read_at).length
    : 0;

  return (
    <main className="app-shell">
      {/* ── Mobile hamburger menu overlay ────────────────────────────────── */}
      {menuOpen && (
        <div className="mobile-menu-overlay" onClick={() => setMenuOpen(false)}>
          <div className="mobile-menu-panel" onClick={e => e.stopPropagation()}>
            <div className="mobile-menu-header">
              <div className="brand-lockup" style={{ padding: 0 }}>
                <Hotel size={20} /><span>{me?.hotel_name || "Zynloc"}</span>
              </div>
              <button className="icon-btn" onClick={() => setMenuOpen(false)}><X size={22} /></button>
            </div>
            <nav className="mobile-menu-nav">
              {NAV.map(([key, Icon, label]) => {
                const badge = key === "alerts"   ? (data.alerts?.unresolved?.length || 0)
                            : key === "messages" ? totalUnreadMessages
                            : 0;
                return (
                  <button key={key}
                    className={`mobile-menu-item ${active === key ? "active" : ""}`}
                    onClick={() => { navigate(key); setMenuOpen(false); }}>
                    <Icon size={20} />
                    <span style={{ flex: 1 }}>{label}</span>
                    {badge > 0 && <span className="nav-badge">{badge}</span>}
                  </button>
                );
              })}
            </nav>
            <button className="logout" style={{ marginTop: "auto" }} onClick={api.logout}>
              <LogOut size={16} />Logout
            </button>
          </div>
        </div>
      )}

      <aside className="sidebar">
        <div className="brand-lockup"><Hotel size={20} /><span>{me?.hotel_name || "Zynloc"}</span></div>
        <nav>
          {NAV.map(([key, Icon, label]) => {
            const badge = key === "alerts"   ? (data.alerts?.unresolved?.length || 0)
                        : key === "messages" ? totalUnreadMessages
                        : 0;
            return (
              <button key={key} className={active === key ? "active" : ""} onClick={() => navigate(key)}>
                <Icon size={16} />
                <span style={{ flex: 1 }}>{label}</span>
                {badge > 0 && <span className="nav-badge">{badge}</span>}
              </button>
            );
          })}
        </nav>
        <button className="logout" onClick={api.logout}><LogOut size={16} />Logout</button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          {/* Hamburger — hidden on desktop, shown on mobile */}
          <button className="hamburger-btn" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Menu size={22} />
          </button>
          <div>
            <p className="eyebrow">Manager dashboard</p>
            <h1>{activeLabel}</h1>
          </div>
          <div className="metrics">
            <Metric label="Occupancy" value={`${occupancy}%`} />
            <Metric label="Rooms" value={data.rooms.length} />
            <Metric label="Revenue" value={`$${revenue}`} />
            {sessionCount > 1 && (
              <div className="session-chip" title={`${sessionCount} devices logged in`}>
                <Monitor size={13} />{sessionCount} devices
              </div>
            )}
            <div className="profile-chip">
              <span>{me?.name?.[0] || "M"}</span>
              <strong>{me?.name || "Manager"}</strong>
            </div>
            {/* Connection indicator */}
            <div className={`conn-dot ${socketConnected ? "connected" : ""}`}
                 title={socketConnected ? "Live — connected" : "Reconnecting…"} />
          </div>
        </header>

        <section className="dashboard-frame">
          <div className="main-pane">
            {active === "overview" && <MgrOverview data={data} onNav={navigate} />}
            {active === "alerts" && <MgrAlerts api={api} data={data} reload={loadAll} show={show} />}
            {active === "rooms" && <MgrRooms api={api} data={data} reload={loadAll} show={show} />}
            {active === "bookings" && <MgrBookings api={api} data={data} reload={loadAll} show={show} />}
            {active === "guests" && <MgrGuests api={api} data={data} reload={loadAll} show={show} />}
            {active === "facilities" && <MgrFacilities api={api} data={data} reload={loadAll} show={show} />}
            {active === "packages" && <MgrPackages api={api} data={data} reload={loadAll} show={show} />}
            {active === "service-requests" && <MgrServiceRequests api={api} data={data} reload={loadAll} show={show} />}
            {active === "access-log" && <MgrAccessLog data={data} />}
            {active === "messages" && (
              <MgrMessagesErrorBoundary key="messages-boundary" onRetry={loadAll}>
                <MgrMessages api={api} data={data} reload={loadAll} />
              </MgrMessagesErrorBoundary>
            )}
            {active === "staff" && <MgrStaff api={api} data={data} reload={loadAll} show={show} />}
            {active === "analytics" && <MgrAnalytics api={api} data={data} />}
            {active === "settings" && <MgrSettings api={api} data={data} reload={loadAll} show={show} />}
          </div>
        </section>
      </section>

      {/* Mobile bottom navigation — visible on phones (≤768px via CSS) */}
      <nav className="mgr-bottom-nav">
        {BOTTOM_NAV.map(([key, Icon, label]) => {
          const badge = key === "alerts"   ? (data.alerts?.unresolved?.length || 0)
                      : key === "messages" ? totalUnreadMessages
                      : 0;
          return (
            <button key={key} className={active === key ? "active" : ""} onClick={() => navigate(key)}>
              <div style={{ position: "relative" }}>
                <Icon size={22} />
                {badge > 0 && (
                  <span style={{ position: "absolute", top: -6, right: -8,
                                 background: "var(--red)", color: "#fff", borderRadius: 9,
                                 minWidth: 16, height: 16, fontSize: 9, fontWeight: 700,
                                 display: "flex", alignItems: "center", justifyContent: "center",
                                 padding: "0 3px" }}>{badge}</span>
                )}
              </div>
              <span>{label}</span>
            </button>
          );
        })}
      </nav>

      <Toast toast={toast} />
    </main>
  );
}

function MgrOverview({ data, onNav }) {
  const occupied = data.rooms.filter(r => r.status === "occupied").length;
  const pending = data.bookings.filter(b => b.status === "pending").length;
  const checkedIn = data.bookings.filter(b => b.status === "checked_in").length;
  const openReqs = data.serviceRequests.filter(r => r.status === "open").length;
  const revenue = Math.round((data.analytics?.revenueByRoom || []).reduce((s, r) => s + Number(r.revenue || 0), 0));
  const unresolvedAlerts = data.alerts.unresolved.length;
  return (
    <div className="overview-grid">
      <div className="stat-card"><strong>{occupied}</strong><span>Occupied rooms</span></div>
      <div className="stat-card"><strong>{pending}</strong><span>Pending check-ins</span></div>
      <div className="stat-card"><strong>{checkedIn}</strong><span>Active guests</span></div>
      <div className="stat-card"><strong>{openReqs}</strong><span>Open service requests</span></div>
      <div className="stat-card wide"><strong>${revenue}</strong><span>Total revenue</span></div>
      {unresolvedAlerts > 0 && (
        <div className="alert-overview-banner wide" onClick={() => onNav?.("alerts")}>
          <Bell size={18} />
          <span><strong>{unresolvedAlerts}</strong> unresolved alert{unresolvedAlerts !== 1 ? "s" : ""} — click to view</span>
        </div>
      )}
      <article className="panel col-span-2">
        <h2>Recent bookings</h2>
        <div className="table">
          {data.bookings.slice(0, 6).map(b => (
            <div className="row" key={b.id}>
              <span>{b.guest_name}</span>
              <span>Room {b.room_number}</span>
              <span className={`pill ${b.status}`}>{b.status}</span>
              <span>{fmtDate(b.check_in)}</span>
            </div>
          ))}
          {!data.bookings.length && <p className="muted">No bookings yet</p>}
        </div>
      </article>
    </div>
  );
}

function MgrRooms({ api, data, reload, show }) {
  const [form, setForm] = useState({ number: "", type: "double", status: "free", pricePerNight: 120, imageUrl: "", zone: "" });
  async function add(e) {
    e.preventDefault();
    try {
      await api.request("/api/rooms", { method: "POST", body: JSON.stringify(form) });
      setForm(f => ({ ...f, number: "", imageUrl: "" }));
      reload(); show("Room added", "success");
    } catch (err) { show(err.message, "error"); }
  }
  return (
    <div className="stack">
      <form className="panel stack" onSubmit={add}>
        <h2>Add room</h2>
        <div className="inline-form">
          <input required placeholder="Room #" value={form.number} onChange={e => setForm({ ...form, number: e.target.value })} />
          <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
            {["single","double","suite","villa"].map(x => <option key={x}>{x}</option>)}
          </select>
          <input type="number" placeholder="$/night" value={form.pricePerNight} onChange={e => setForm({ ...form, pricePerNight: +e.target.value })} />
        </div>
        <label className="upload-field-label">Room photo (optional)</label>
        <ImageUpload value={form.imageUrl} onChange={v => setForm({ ...form, imageUrl: v })} label="Upload room photo" maxWidth={800} />
        <button className="primary" type="submit"><Plus size={18} />Add room</button>
      </form>
      <div className="cards">
        {data.rooms.map(room => (
          <article className="room-card" key={room.id}>
            <ZoomImg src={room.image_url} alt={`Room ${room.number}`} block />
            <div>
              <BedDouble size={14} /><h3>{room.number}</h3>
              <p>{room.type} · ${room.price_per_night}/night</p>
              <span className={`pill ${room.status}`}>{room.status}</span>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function MgrBookings({ api, data, reload, show }) {
  const [form, setForm] = useState({ guestName: "", guestEmail: "", guestPhone: "", roomId: "", packageId: "", checkIn: "", checkOut: "", specialNotes: "" });
  const [created, setCreated] = useState(null);
  const [resending, setResending] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [checkinData, setCheckinData] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [search, setSearch] = useState("");
  const [revoking, setRevoking] = useState(null);

  async function create(e) {
    e.preventDefault();
    try {
      const result = await api.request("/api/bookings", { method: "POST", body: JSON.stringify(form) });
      setCreated(result);
      reload();
      show("Booking created — email sent to guest", "success");
    } catch (err) { show(err.message, "error"); }
  }

  async function resend(id) {
    setResending(id);
    try { await api.request(`/api/bookings/${id}/resend-email`, { method: "POST" }); show("Email resent", "success"); }
    catch (err) { show(err.message, "error"); }
    setResending(null);
  }

  async function handleCheckinScan(qrData) {
    setScanning(false);
    // QR encodes a URL like .../checkin-scan/TOKEN — extract last segment
    const token = qrData.includes("/") ? qrData.split("/").pop() : qrData;
    try {
      const b = await api.request("/api/bookings/scan-checkin", { method: "POST", body: JSON.stringify({ token }) });
      setCheckinData(b);
    } catch (err) { show(err.message, "error"); }
  }

  async function confirmCheckin() {
    if (!checkinData?.qr_token) return;
    setConfirming(true);
    try {
      await api.request(`/api/guest/${checkinData.qr_token}/checkin`, { method: "POST" });
      show(`${checkinData.guest_name} checked in to Room ${checkinData.room_number} ✓`, "success");
      setCheckinData(null);
      reload();
    } catch (err) { show(err.message, "error"); }
    finally { setConfirming(false); }
  }

  function flagIssue() {
    show(`Issue flagged for ${checkinData?.guest_name} — Room ${checkinData?.room_number}`, "warning");
    setCheckinData(null);
  }

  async function revokeBooking(id) {
    setRevoking(id);
    try { await api.request(`/api/bookings/${id}/revoke`, { method: "POST" }); reload(); show("Access revoked", "success"); }
    catch (err) { show(err.message, "error"); }
    setRevoking(null);
  }

  async function restoreBooking(id) {
    setRevoking(id);
    try { await api.request(`/api/bookings/${id}/restore`, { method: "POST" }); reload(); show("Access restored", "success"); }
    catch (err) { show(err.message, "error"); }
    setRevoking(null);
  }

  const filteredBookings = search.trim()
    ? data.bookings.filter(b =>
        (b.guest_name || "").toLowerCase().includes(search.toLowerCase()) ||
        (b.guest_email || "").toLowerCase().includes(search.toLowerCase())
      )
    : data.bookings;

  return (
    <section className="split">
      <form className="panel stack" onSubmit={create}>
        <h2>New booking</h2>
        <input required placeholder="Guest name" value={form.guestName} onChange={e => setForm({ ...form, guestName: e.target.value })} />
        <input required type="email" placeholder="Guest email" value={form.guestEmail} onChange={e => setForm({ ...form, guestEmail: e.target.value })} />
        <input placeholder="Guest phone" value={form.guestPhone} onChange={e => setForm({ ...form, guestPhone: e.target.value })} />
        <select required value={form.roomId} onChange={e => setForm({ ...form, roomId: e.target.value })}>
          <option value="">Select room</option>
          {data.rooms.filter(r => r.status === "free").map(r => <option key={r.id} value={r.id}>Room {r.number} · {r.type}</option>)}
        </select>
        <select value={form.packageId} onChange={e => setForm({ ...form, packageId: e.target.value })}>
          <option value="">No package (custom facilities)</option>
          {data.packages.map(p => <option key={p.id} value={p.id}>{p.name} (+${p.price})</option>)}
        </select>
        <label className="input-label">Check-in</label>
        <input required type="datetime-local" value={form.checkIn} onChange={e => setForm({ ...form, checkIn: e.target.value })} />
        <label className="input-label">Check-out</label>
        <input required type="datetime-local" value={form.checkOut} onChange={e => setForm({ ...form, checkOut: e.target.value })} />
        <textarea placeholder="Special notes" value={form.specialNotes} onChange={e => setForm({ ...form, specialNotes: e.target.value })} rows={2} />
        <button className="primary" type="submit"><QrCode size={18} />Create booking &amp; send email</button>
        {created && (
          <div className="booking-created">
            <p className="success-text"><CheckCircle size={16} /> Booking created!</p>
            <QrBlock dataUrl={created.qr_data_url} label={`Room ${created.room_number} — guest QR`} caption="This was emailed to the guest" />
            <a className="mini-link" href={`/guest/${created.qr_token}`} target="_blank" rel="noreferrer">Open guest app ↗</a>
          </div>
        )}
      </form>

      <div className="stack">
        <div className="scan-row">
          <button className="primary sm" onClick={() => setScanning(true)}>
            <QrCode size={16} />Scan Guest QR
          </button>
          <span className="muted scan-hint">Tap to scan a guest's check-in QR</span>
        </div>

        {checkinData && (
          <div className="checkin-panel-wrap">
            <CheckinConfirmPanel
              booking={checkinData}
              onConfirm={confirmCheckin}
              onFlag={flagIssue}
              onClose={() => setCheckinData(null)}
              confirming={confirming}
            />
          </div>
        )}

        <div className="guest-search">
          <Users size={14} />
          <input
            placeholder="Search by name or email…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <div className="table">
          {filteredBookings.map(b => (
            <div className="row booking-row" key={b.id}
              style={{ cursor: b.qr_token ? "pointer" : "default", opacity: b.revoked ? 0.6 : 1 }}
              onClick={() => { if (b.qr_token && !b.revoked) setCheckinData({ ...b, facilities: [] }); }}
            >
              <div className="guest-avatar booking-avatar">
                {b.selfie_url
                  ? <img src={b.selfie_url} alt={b.guest_name} className="booking-avatar-img" />
                  : <span>{b.guest_name?.[0] || "?"}</span>
                }
              </div>
              <div><strong>{b.guest_name}</strong><small>{b.guest_email}</small></div>
              <span>Room {b.room_number}</span>
              <span className={`pill ${b.revoked ? "revoked" : b.status}`}>{b.revoked ? "revoked" : b.status}</span>
              <span>{fmtDate(b.check_in)}</span>
              <span className={`pill ${b.profile_status || "pending"}`}>{b.profile_status || "pending"}</span>
              <div className="row-actions" onClick={e => e.stopPropagation()}>
                {b.qr_data_url && <img src={b.qr_data_url} alt="QR" className="mini-qr" />}
                <button className="ghost sm" onClick={() => resend(b.id)} disabled={resending === b.id}>
                  {resending === b.id ? "Sending…" : "Resend"}
                </button>
                {b.revoked
                  ? <button className="restore-btn" onClick={() => restoreBooking(b.id)} disabled={revoking === b.id}>
                      <CheckCircle size={12} />{revoking === b.id ? "…" : "Restore"}
                    </button>
                  : <button className="revoke-btn" onClick={() => revokeBooking(b.id)} disabled={revoking === b.id}>
                      <X size={12} />{revoking === b.id ? "…" : "Revoke"}
                    </button>
                }
              </div>
            </div>
          ))}
          {!filteredBookings.length && <p className="muted">{search ? "No matching bookings" : "No bookings yet"}</p>}
        </div>
      </div>

      {scanning && <QrScanner onScan={handleCheckinScan} onClose={() => setScanning(false)} bookings={data.bookings} />}
    </section>
  );
}

function MgrGuests({ api, data, reload, show }) {
  const [revoking, setRevoking] = useState(null);

  async function revokeBooking(bookingId) {
    setRevoking(bookingId);
    try { await api.request(`/api/bookings/${bookingId}/revoke`, { method: "POST" }); reload(); show("Access revoked", "success"); }
    catch (err) { show(err.message, "error"); }
    setRevoking(null);
  }

  async function restoreBooking(bookingId) {
    setRevoking(bookingId);
    try { await api.request(`/api/bookings/${bookingId}/restore`, { method: "POST" }); reload(); show("Access restored", "success"); }
    catch (err) { show(err.message, "error"); }
    setRevoking(null);
  }

  function getStatus(g) {
    if (g.revoked) return "revoked";
    if (g.booking_status === "current") return "checked-in";
    if (g.booking_status === "past") return "checked-out";
    if (g.booking_status === "pending") return g.profile_status === "complete" ? "upcoming" : "pending";
    return "pending";
  }

  const STATUS_LABEL = { "revoked": "Revoked", "checked-in": "Checked In", "checked-out": "Checked Out", "upcoming": "Upcoming", "pending": "Pending" };

  function getDayProgress(g) {
    if (g.booking_status !== "current" || !g.check_in || !g.check_out) return null;
    const total = Math.max(1, Math.ceil((new Date(g.check_out) - new Date(g.check_in)) / 86400000));
    const elapsed = Math.max(1, Math.ceil((Date.now() - new Date(g.check_in)) / 86400000));
    return `Day ${Math.min(elapsed, total)} of ${total}`;
  }

  return (
    <div className="guest-cards">
      {data.guests.map(g => {
        const status = getStatus(g);
        const dayProgress = getDayProgress(g);
        return (
          <div className={`guest-card ${g.revoked ? "opacity-60" : ""}`} key={g.id}>
            <div className="guest-card-photo">
              {g.selfie_url
                ? <ZoomImg src={g.selfie_url} alt={g.name} className="guest-thumb-img" />
                : <span className="guest-avatar-initial">{g.name?.[0] || "?"}</span>}
            </div>
            <div className="guest-card-body">
              <div className="guest-card-top">
                <strong className="guest-card-name">{g.name || "Unknown"}</strong>
                <span className={`pill ${status}`}>{STATUS_LABEL[status] || status}</span>
              </div>
              <small className="muted">{g.email}</small>
              <div className="guest-card-details">
                {g.room_number && <span>Room {g.room_number}{g.room_type ? ` · ${g.room_type}` : ""}</span>}
                {g.check_in && <span>{new Date(g.check_in).toLocaleDateString()} – {new Date(g.check_out).toLocaleDateString()}</span>}
                {g.package_type && <span>Package: {g.package_type}</span>}
                {dayProgress && <span className="day-progress">{dayProgress}</span>}
                {g.current_location && <span>📍 {g.current_location}</span>}
              </div>
              {g.booking_id && (
                <div className="guest-card-actions">
                  {g.revoked
                    ? <button className="restore-btn" onClick={() => restoreBooking(g.booking_id)} disabled={revoking === g.booking_id}>
                        <CheckCircle size={12} />{revoking === g.booking_id ? "…" : "Restore"}
                      </button>
                    : <button className="revoke-btn" onClick={() => revokeBooking(g.booking_id)} disabled={revoking === g.booking_id}>
                        <X size={12} />{revoking === g.booking_id ? "…" : "Revoke"}
                      </button>
                  }
                </div>
              )}
            </div>
          </div>
        );
      })}
      {!data.guests.length && <p className="muted">No guests yet</p>}
    </div>
  );
}

function MgrFacilities({ api, data, reload, show }) {
  const [form, setForm] = useState({ name: "", icon: "Star", zone: "", description: "" });
  const [qrModal, setQrModal] = useState(null);

  async function add(e) {
    e.preventDefault();
    try {
      await api.request("/api/facilities", { method: "POST", body: JSON.stringify(form) });
      setForm(f => ({ ...f, name: "" }));
      reload(); show("Facility added", "success");
    } catch (err) { show(err.message, "error"); }
  }

  async function showQr(facilityId) {
    try {
      const r = await api.request(`/api/facilities/${facilityId}/qr`, { method: "POST" });
      setQrModal(r);
    } catch (err) { show(err.message, "error"); }
  }

  return (
    <>
      <GridPage form={
        <form className="inline-form" onSubmit={add}>
          <input required placeholder="Facility name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <input placeholder="Zone" value={form.zone} onChange={e => setForm({ ...form, zone: e.target.value })} />
          <button className="primary" type="submit"><Plus size={18} />Add</button>
        </form>
      }>
        {data.facilities.map(f => (
          <article className="card" key={f.id}>
            <Dumbbell size={18} /><h3>{f.name}</h3>
            <p>{f.zone || "—"} · {f.active_guest_count || 0} guests</p>
            <button className="ghost sm" onClick={() => showQr(f.id)}><QrCode size={13} /> QR</button>
          </article>
        ))}
      </GridPage>
      <Modal open={!!qrModal} onClose={() => setQrModal(null)}>
        {qrModal && <QrBlock dataUrl={qrModal.qr_data_url} label={qrModal.facility_name || "Facility QR"} caption="Print and place at facility entrance" />}
      </Modal>
    </>
  );
}

function MgrPackages({ api, data, reload, show }) {
  const [form, setForm] = useState({ name: "", description: "", price: 0, facilityIds: [] });

  async function add(e) {
    e.preventDefault();
    try {
      await api.request("/api/packages", { method: "POST", body: JSON.stringify(form) });
      setForm({ name: "", description: "", price: 0, facilityIds: [] });
      reload(); show("Package added", "success");
    } catch (err) { show(err.message, "error"); }
  }

  async function del(id) {
    try { await api.request(`/api/packages/${id}`, { method: "DELETE" }); reload(); }
    catch (err) { show(err.message, "error"); }
  }

  return (
    <section className="split">
      <form className="panel stack" onSubmit={add}>
        <h2>New package</h2>
        <input required placeholder="Package name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <input placeholder="Description" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
        <input type="number" placeholder="Add-on price ($)" value={form.price} onChange={e => setForm({ ...form, price: +e.target.value })} />
        <div className="check-list">
          {data.facilities.map(f => (
            <label key={f.id}>
              <input type="checkbox" checked={form.facilityIds.includes(f.id)} onChange={e => setForm(prev => ({
                ...prev,
                facilityIds: e.target.checked ? [...prev.facilityIds, f.id] : prev.facilityIds.filter(x => x !== f.id)
              }))} />{f.name}
            </label>
          ))}
        </div>
        <button className="primary" type="submit"><Plus size={18} />Add package</button>
      </form>
      <div className="cards">
        {data.packages.map(p => (
          <article className="card" key={p.id}>
            <Star size={18} /><h3>{p.name}</h3>
            <p>{p.description || "—"}</p><strong>${p.price}</strong>
            <button className="ghost sm danger" onClick={() => del(p.id)}><X size={13} /></button>
          </article>
        ))}
        {!data.packages.length && <p className="muted">No packages yet</p>}
      </div>
    </section>
  );
}

function MgrServiceRequests({ api, data, reload, show }) {
  async function updateStatus(id, status) {
    try { await api.request(`/api/service-requests/${id}`, { method: "PUT", body: JSON.stringify({ status }) }); reload(); }
    catch (err) { show(err.message, "error"); }
  }
  return (
    <div className="table wide-table">
      {data.serviceRequests.map(r => (
        <div className="row" key={r.id}>
          <span>{r.guest_name}</span>
          <span>Room {r.room_number}</span>
          <span className="pill">{r.type}</span>
          <span>{r.description || "—"}</span>
          <span className={`pill ${r.status}`}>{r.status}</span>
          <span>{fmtTime(r.created_at)}</span>
          <div className="row-actions">
            {r.status === "open" && <button className="ghost sm" onClick={() => updateStatus(r.id, "in_progress")}>Start</button>}
            {r.status !== "resolved" && <button className="ghost sm" onClick={() => updateStatus(r.id, "resolved")}>Resolve</button>}
          </div>
        </div>
      ))}
      {!data.serviceRequests.length && <p className="muted">No service requests</p>}
    </div>
  );
}

function MgrAccessLog({ data }) {
  return (
    <div className="table wide-table">
      {data.accessLog.map(entry => (
        <div className="row" key={entry.id}>
          <span>{entry.guest_name}</span>
          <span>{entry.facility_name}</span>
          <span className={`pill ${entry.result}`}>{entry.result}</span>
          <span>{new Date(entry.scanned_at).toLocaleString()}</span>
        </div>
      ))}
      {!data.accessLog.length && <p className="muted">No access events yet</p>}
    </div>
  );
}

// ── Alerts Tab ────────────────────────────────────────────────────────────────

const ALERT_ICONS = {
  arrival:         "🚶",
  checkin:         "✅",
  checkout:        "🚪",
  access_denied:   "🔒",
  service_request: "🛎️",
  late_checkout:   "⏰",
};

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function MgrAlerts({ api, data, reload, show }) {
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const [busy, setBusy] = useState(null);

  async function resolve(id) {
    setBusy(id);
    try {
      await api.request(`/api/alerts/${id}/resolve`, { method: "POST" });
      reload();
    } catch (err) { show(err.message, "error"); }
    setBusy(null);
  }

  async function unresolve(id) {
    setBusy(id);
    try {
      await api.request(`/api/alerts/${id}/unresolve`, { method: "POST" });
      reload();
    } catch (err) { show(err.message, "error"); }
    setBusy(null);
  }

  async function confirmCheckin(qrToken, guestName, roomNum) {
    try {
      await api.request(`/api/guest/${qrToken}/checkin`, { method: "POST" });
      show(`${guestName} checked in to Room ${roomNum} ✓`, "success");
      reload();
    } catch (err) { show(err.message, "error"); }
  }

  function AlertCard({ a, resolved }) {
    const icon = ALERT_ICONS[a.type] || "🔔";
    return (
      <div className={`alert-card ${a.type}`}>
        <div className="alert-card-top">
          <span className="alert-icon">{icon}</span>
          <div className="alert-card-body">
            <strong>{a.title}</strong>
            {a.message && <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>{a.message}</p>}
          </div>
          <span className="alert-time">{timeAgo(a.created_at)}</span>
        </div>
        <div className="alert-card-actions">
          {!resolved && a.type === "arrival" && a.qr_token && (
            <button className="arrival-confirm-btn" style={{ flex: "unset", fontSize: 12, padding: "6px 12px" }}
              onClick={() => confirmCheckin(a.qr_token, a.guest_name, a.message?.match(/Room (\w+)/)?.[1] || "")}>
              <Check size={13} />Confirm Check-In
            </button>
          )}
          {!resolved ? (
            <button className="alert-resolve-btn" disabled={busy === a.id} onClick={() => resolve(a.id)}>
              {busy === a.id ? "…" : "Resolve"}
            </button>
          ) : (
            <button className="alert-unresolve-btn" disabled={busy === a.id} onClick={() => unresolve(a.id)}>
              {busy === a.id ? "…" : "Re-open"}
            </button>
          )}
        </div>
      </div>
    );
  }

  const { unresolved = [], resolved = [] } = data.alerts || {};

  return (
    <div className="stack">
      <div className="section-header">
        <h2>Unresolved Alerts {unresolved.length > 0 && <span className="nav-badge" style={{ fontSize: 12 }}>{unresolved.length}</span>}</h2>
      </div>
      {unresolved.length === 0
        ? <p className="muted">No unresolved alerts — all clear!</p>
        : <div className="alert-list">{unresolved.map(a => <AlertCard key={a.id} a={a} resolved={false} />)}</div>
      }

      <div className="section-header" style={{ marginTop: 8, cursor: "pointer" }} onClick={() => setResolvedOpen(o => !o)}>
        <h2 style={{ color: "var(--muted)", fontSize: 14 }}>
          Resolved ({resolved.length}) {resolvedOpen ? "▲" : "▼"}
        </h2>
      </div>
      {resolvedOpen && (
        resolved.length === 0
          ? <p className="muted">No resolved alerts yet</p>
          : <div className="alert-list">{resolved.map(a => <AlertCard key={a.id} a={a} resolved />)}</div>
      )}
    </div>
  );
}

// ── Error boundary — catches JS errors inside MgrMessages and shows them ──────
class MgrMessagesErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(err) { return { error: err }; }
  componentDidCatch(err) { console.error("[MgrMessages crash]", err); }
  render() {
    if (this.state.error) {
      return (
        <div className="panel" style={{ textAlign: "center", padding: 40, display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>
          <MessageSquare size={40} style={{ color: "var(--muted)" }} />
          <p className="error">Messages failed to load: {this.state.error.message}</p>
          <button className="secondary" style={{ width: "auto" }}
            onClick={() => { this.setState({ error: null }); this.props.onRetry?.(); }}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function MgrMessages({ api, data, reload }) {
  const [selectedGuestId, setSelectedGuestId] = useState(null);
  const [body,            setBody]            = useState("");
  const [showBroadcast,   setShowBroadcast]   = useState(false);
  const [broadcastBody,   setBroadcastBody]   = useState("");
  const [broadcasting,    setBroadcasting]    = useState(false);
  const [readLocally,     setReadLocally]     = useState(new Set()); // guestIds marked read this session
  const endRef = useRef(null);

  const conversations = useMemo(() => {
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const guests   = Array.isArray(data?.guests)   ? data.guests   : [];
    const map = new Map();
    for (const m of messages) {
      if (!m.guest_id) continue;
      if (!map.has(m.guest_id)) {
        const guest = guests.find(g => g.id === m.guest_id) || { id: m.guest_id, name: m.guest_name || "Guest" };
        map.set(m.guest_id, { guest, messages: [] });
      }
      map.get(m.guest_id).messages.push(m);
    }
    for (const conv of map.values()) {
      conv.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }
    return Array.from(map.values()).sort((a, b) => {
      const aLast = a.messages[a.messages.length - 1]?.created_at || 0;
      const bLast = b.messages[b.messages.length - 1]?.created_at || 0;
      return new Date(bLast) - new Date(aLast);
    });
  }, [data?.messages, data?.guests]);

  // Unread count per guest — 0 if already marked read this session
  function unreadFor(guestId) {
    if (readLocally.has(guestId)) return 0;
    return (data?.messages || []).filter(m =>
      m.guest_id === guestId && m.sender === "guest" && !m.read_at
    ).length;
  }

  const selectedConv = conversations.find(c => c.guest.id === selectedGuestId) || null;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [selectedConv?.messages?.length, selectedGuestId]);

  // Auto-select first conversation when list loads
  useEffect(() => {
    if (!selectedGuestId && conversations.length > 0) {
      setSelectedGuestId(conversations[0].guest.id);
    }
  }, [conversations.length]);

  // Mark as read when a conversation is opened
  useEffect(() => {
    if (!selectedGuestId) return;
    setReadLocally(prev => new Set([...prev, selectedGuestId])); // instant badge clear
    api.request("/api/messages/mark-read", {
      method: "POST",
      body: JSON.stringify({ guestId: selectedGuestId })
    }).then(() => reload()).catch(() => {});
  }, [selectedGuestId]);

  async function send(e) {
    e.preventDefault();
    if (!body.trim() || !selectedGuestId) return;
    try {
      await api.request("/api/messages", {
        method: "POST",
        body: JSON.stringify({ body, guestId: selectedGuestId })
      });
      setBody("");
      reload();
    } catch {}
  }

  async function sendBroadcast(e) {
    e.preventDefault();
    if (!broadcastBody.trim()) return;
    setBroadcasting(true);
    try {
      const result = await api.request("/api/messages/broadcast", {
        method: "POST",
        body: JSON.stringify({ body: broadcastBody })
      });
      setShowBroadcast(false);
      setBroadcastBody("");
      reload();
    } catch {}
    setBroadcasting(false);
  }

  return (
    <>
      {/* ── Emergency broadcast modal ─────────────────────────────────── */}
      {showBroadcast && (
        <div className="modal-overlay" onClick={() => setShowBroadcast(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <h2 style={{ color: "var(--red)", marginBottom: 4 }}>⚠️ Emergency Broadcast</h2>
            <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
              This message will be sent to <strong>all checked-in guests</strong> immediately.
            </p>
            <form className="stack" onSubmit={sendBroadcast}>
              <textarea
                placeholder="e.g. Fire drill at 3pm. Please proceed to the main entrance."
                value={broadcastBody}
                onChange={e => setBroadcastBody(e.target.value)}
                rows={4}
                required
                autoFocus
              />
              <div style={{ display: "flex", gap: 10 }}>
                <button type="submit" className="primary" style={{ background: "var(--red)", flex: 1 }}
                  disabled={broadcasting || !broadcastBody.trim()}>
                  {broadcasting ? "Sending…" : "Send to All Guests"}
                </button>
                <button type="button" className="secondary" onClick={() => setShowBroadcast(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="chat-shell">
        {/* ── Left sidebar ─────────────────────────────────────────────── */}
        <div className="chat-sidebar">
          <div className="chat-sidebar-header" style={{ justifyContent: "space-between" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <MessageSquare size={16} /> Conversations
            </span>
            <button
              title="Emergency Broadcast"
              onClick={() => setShowBroadcast(true)}
              style={{ background: "rgba(239,95,95,.15)", border: "1px solid rgba(239,95,95,.4)",
                       color: "var(--red)", borderRadius: 6, padding: "3px 8px", fontSize: 12,
                       cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
              📢 Broadcast
            </button>
          </div>
          {conversations.length === 0 && (
            <p className="muted" style={{ padding: "16px 12px", fontSize: 13 }}>No messages yet</p>
          )}
          {conversations.map(conv => {
            const lastMsg  = conv.messages[conv.messages.length - 1];
            const unread   = unreadFor(conv.guest.id);
            const isBcast  = lastMsg?.broadcast && !lastMsg?.guest_id;
            const preview  = isBcast ? `📢 ${lastMsg.body}` : (lastMsg?.body?.slice(0, 38) || "");
            return (
              <div key={conv.guest.id}
                className={`chat-thread-item ${selectedGuestId === conv.guest.id ? "active" : ""}`}
                onClick={() => setSelectedGuestId(conv.guest.id)}>
                <div className="chat-thread-avatar">
                  {conv.guest.selfie_url
                    ? <img src={conv.guest.selfie_url} alt={conv.guest.name} />
                    : <span>{conv.guest.name?.[0] || "?"}</span>}
                </div>
                <div className="chat-thread-info">
                  <strong>{conv.guest.name}</strong>
                  <p className="chat-thread-preview">{preview}</p>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                  <span className="chat-thread-time">{fmtTime(lastMsg?.created_at)}</span>
                  {unread > 0 && <span className="nav-badge" style={{ fontSize: 10 }}>{unread}</span>}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Right chat area ───────────────────────────────────────────── */}
        <div className="chat-main">
          {selectedConv ? (
            <>
              <div className="chat-main-header">
                <div className="chat-thread-avatar sm">
                  {selectedConv.guest.selfie_url
                    ? <img src={selectedConv.guest.selfie_url} alt={selectedConv.guest.name} />
                    : <span>{selectedConv.guest.name?.[0] || "?"}</span>}
                </div>
                <div>
                  <strong>{selectedConv.guest.name}</strong>
                  {selectedConv.guest.room_number && (
                    <small className="muted"> · Room {selectedConv.guest.room_number}</small>
                  )}
                </div>
              </div>

              <div className="chat-messages">
                {selectedConv.messages.map(m => {
                  const isOutgoing = m.sender === "staff";
                  const senderLabel = isOutgoing
                    ? (m.sender_display_name || m.staff_display_name || m.staff_name || "Staff")
                    : (m.guest_name || "Guest");
                  return (
                    <div key={m.id} className={`chat-msg-row ${isOutgoing ? "outgoing" : "incoming"}`}>
                      {m.broadcast && <span className="broadcast-label">📢 BROADCAST</span>}
                      <span className="chat-msg-sender">{senderLabel}</span>
                      <div className={`chat-msg-bubble ${isOutgoing ? "outgoing" : "incoming"}`}>
                        {m.body}
                      </div>
                      <span className="chat-msg-time">{fmtTime(m.created_at)}</span>
                    </div>
                  );
                })}
                <div ref={endRef} />
              </div>

              <form className="chat-input-bar" onSubmit={send}>
                <input placeholder="Type a message…" value={body} onChange={e => setBody(e.target.value)} />
                <button type="submit" className="chat-send-btn" disabled={!body.trim()}>
                  <Send size={18} />
                </button>
              </form>
            </>
          ) : (
            <div className="chat-empty-state">
              <MessageSquare size={40} style={{ color: "var(--muted)" }} />
              <p className="muted">Select a conversation</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function MgrStaff({ api, data, reload, show }) {
  const [form, setForm] = useState({ name: "", email: "", displayName: "", password: "staff123!", role: "housekeeping", zone: "" });
  async function add(e) {
    e.preventDefault();
    try {
      await api.request("/api/staff", { method: "POST", body: JSON.stringify(form) });
      setForm(f => ({ ...f, name: "", email: "", displayName: "" }));
      reload(); show("Staff added", "success");
    } catch (err) { show(err.message, "error"); }
  }
  return (
    <GridPage form={
      <form className="inline-form" onSubmit={add}>
        <input required placeholder="Full name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <input placeholder="Display name (chat)" value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} />
        <input required type="email" placeholder="Email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
        <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
          {["housekeeping","security","receptionist","manager"].map(r => <option key={r}>{r}</option>)}
        </select>
        <button className="primary" type="submit"><Plus size={18} />Add</button>
      </form>
    }>
      {data.staff.map(s => (
        <article className="card" key={s.id}>
          <ShieldCheck size={18} />
          <h3>{s.name}</h3>
          {s.display_name && <p className="muted" style={{ fontSize: 12 }}>Chat: {s.display_name}</p>}
          <p>{s.role} · {s.zone || "All zones"}</p>
        </article>
      ))}
    </GridPage>
  );
}

function MgrAnalytics({ api, data }) {
  const a = data.analytics || {};
  const daily = (a.revenueByRoom || []).map(r => ({ name: r.room_number, revenue: Number(r.revenue) }));

  async function exportCsv() {
    const res = await fetch(`${API}/api/reports/bookings.csv`, { headers: { Authorization: `Bearer ${api.token}` } });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "zynloc-bookings.csv"; anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="analytics-grid">
      <article className="panel"><h2>Occupancy by month</h2><GoldAreaChart data={a.occupancyByMonth || []} dataKey="occupancy_rate" xKey="month" /></article>
      <article className="panel"><h2>Revenue per room</h2><GoldBarChart data={daily} /></article>
      <article className="panel"><h2>Avg stay length</h2><div className="big-number">{a.averageLengthOfStay || 0} nights</div></article>
      <article className="panel"><h2>Facility usage</h2><GoldAreaChart data={a.facilityUsage || []} dataKey="scans" xKey="name" /></article>
      <article className="panel"><h2>Export</h2><button className="primary" onClick={exportCsv}><FileDown size={18} />Export CSV</button></article>
    </div>
  );
}

function MgrSettings({ api, data, reload, show }) {
  const s = data.settings || {};
  const [form, setForm] = useState({ name: s.name || "", address: s.address || "", logoUrl: s.logo_url || "", coverPhotoUrl: s.cover_photo_url || "", receptionPhone: s.reception_phone || "" });
  const [tab, setTab] = useState("brand");
  const [waypoints, setWaypoints] = useState([]);
  const [connections, setConnections] = useState([]);
  const [wpForm, setWpForm] = useState({ name: "", x: 0, y: 0, floor: 1, photoUrl: "" });
  const [connForm, setConnForm] = useState({ fromWaypointId: "", toWaypointId: "", distance: 1 });
  const [checkoutQr, setCheckoutQr] = useState(s.checkout_qr || null);
  const [receptionQr, setReceptionQr] = useState(null);
  const [receptionExpiry, setReceptionExpiry] = useState(null);

  // ── Email config state ──
  const [smtpConfigs, setSmtpConfigs] = useState([]);
  const SMTP_BLANK = { provider: "brevo", label: "Default", senderName: "", email: "", smtpPass: "", smtpHost: "smtp.example.com", smtpPort: 587, smtpUser: "" };
  const [smtpForm, setSmtpForm] = useState(SMTP_BLANK);
  const [smtpAdding, setSmtpAdding] = useState(false);
  const [smtpTestTo, setSmtpTestTo] = useState("");
  const [smtpTesting, setSmtpTesting] = useState(null);

  useEffect(() => { setForm({ name: s.name || "", address: s.address || "", logoUrl: s.logo_url || "", coverPhotoUrl: s.cover_photo_url || "", receptionPhone: s.reception_phone || "" }); setCheckoutQr(s.checkout_qr || null); }, [data.settings]);

  useEffect(() => {
    api.request("/api/navigation/waypoints").then(setWaypoints).catch(() => {});
    api.request("/api/navigation/connections").then(setConnections).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab === "email") api.request("/api/smtp").then(setSmtpConfigs).catch(() => {});
    if (tab === "qr") {
      api.request("/api/settings/reception-qr").then(r => {
        setReceptionQr(r.qr_data_url);
        setReceptionExpiry(Math.max(0, Math.floor((new Date(r.expires_at) - Date.now()) / 60000)));
      }).catch(() => {});
    }
  }, [tab]);

  async function addSmtp(e) {
    e.preventDefault();
    try {
      const cfg = await api.request("/api/smtp", { method: "POST", body: JSON.stringify(smtpForm) });
      setSmtpConfigs(c => [...c, cfg]);
      setSmtpForm(SMTP_BLANK);
      setSmtpAdding(false);
      show("Email config saved", "success");
    } catch (err) { show(err.message, "error"); }
  }

  async function deleteSmtp(id) {
    if (!confirm("Delete this SMTP config?")) return;
    try {
      await api.request(`/api/smtp/${id}`, { method: "DELETE" });
      setSmtpConfigs(c => c.filter(x => x.id !== id));
      show("Deleted", "success");
    } catch (err) { show(err.message, "error"); }
  }

  async function setDefaultSmtp(id) {
    try {
      await api.request(`/api/smtp/${id}/set-default`, { method: "POST" });
      setSmtpConfigs(c => c.map(x => ({ ...x, is_default: x.id === id })));
      show("Default updated", "success");
    } catch (err) { show(err.message, "error"); }
  }

  async function testSmtp(id) {
    if (!smtpTestTo) { show("Enter a recipient email address", "error"); return; }
    setSmtpTesting(id);
    try {
      await api.request(`/api/smtp/${id}/test`, { method: "POST", body: JSON.stringify({ to: smtpTestTo }) });
      show(`Test email sent to ${smtpTestTo}`, "success");
    } catch (err) { show(err.message, "error"); }
    finally { setSmtpTesting(null); }
  }

  async function saveBrand(e) {
    e.preventDefault();
    try { await api.request("/api/settings", { method: "PUT", body: JSON.stringify(form) }); reload(); show("Saved", "success"); }
    catch (err) { show(err.message, "error"); }
  }

  async function addWp(e) {
    e.preventDefault();
    try {
      const wp = await api.request("/api/navigation/waypoints", { method: "POST", body: JSON.stringify(wpForm) });
      setWaypoints(w => [...w, wp]); setWpForm(f => ({ ...f, name: "", photoUrl: "" }));
    } catch (err) { show(err.message, "error"); }
  }

  async function addConn(e) {
    e.preventDefault();
    try {
      const conn = await api.request("/api/navigation/connections", { method: "POST", body: JSON.stringify(connForm) });
      setConnections(c => [...c, conn]);
    } catch (err) { show(err.message, "error"); }
  }

  async function regenQr() {
    try { const r = await api.request("/api/settings/checkout-qr", { method: "POST" }); setCheckoutQr(r.qr_data_url); show("Checkout QR regenerated", "success"); }
    catch (err) { show(err.message, "error"); }
  }

  return (
    <div className="settings-shell">
      <div className="settings-tabs">
        {["brand","email","navigation","qr"].map(t => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{cap(t)}</button>
        ))}
      </div>

      {tab === "brand" && (
        <form className="panel stack" onSubmit={saveBrand}>
          <h2>Hotel brand</h2>
          <input placeholder="Hotel name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <input placeholder="Address" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
          <input placeholder="Reception phone" value={form.receptionPhone} onChange={e => setForm({ ...form, receptionPhone: e.target.value })} />
          <label className="upload-field-label">Hotel logo</label>
          <ImageUpload value={form.logoUrl} onChange={v => setForm({ ...form, logoUrl: v })} label="Upload logo" maxWidth={400} />
          <label className="upload-field-label">Cover photo</label>
          <ImageUpload value={form.coverPhotoUrl} onChange={v => setForm({ ...form, coverPhotoUrl: v })} label="Upload cover photo" maxWidth={1200} />
          <button className="primary"><Check size={18} />Save</button>
        </form>
      )}

      {tab === "email" && (
        <div className="stack">
          <h2>Email configuration</h2>
          <p className="muted">Choose how your hotel sends emails to guests — booking confirmations, receipts, and verification requests.</p>

          {smtpConfigs.length > 0 && (
            <div className="smtp-list">
              {smtpConfigs.map(cfg => (
                <div key={cfg.id} className={`smtp-card ${cfg.is_default ? "default" : ""}`}>
                  <div className="smtp-card-header">
                    <span className="smtp-label">{cfg.label}</span>
                    <span className={`smtp-provider-badge smtp-provider-${cfg.provider || "custom"}`}>
                      {cfg.provider === "brevo" ? "Brevo" : cfg.provider === "gmail" ? "Gmail" : "Custom SMTP"}
                    </span>
                    {cfg.is_default && <span className="smtp-badge">Default</span>}
                  </div>
                  <div className="smtp-card-body">
                    <span>{cfg.sender_name} &lt;{cfg.email}&gt;</span>
                    {cfg.provider === "custom" && <span className="muted">{cfg.smtp_host}:{cfg.smtp_port}</span>}
                  </div>
                  <div className="smtp-card-actions">
                    {!cfg.is_default && (
                      <button className="ghost sm" onClick={() => setDefaultSmtp(cfg.id)}>Set default</button>
                    )}
                    <button className="ghost sm danger" onClick={() => deleteSmtp(cfg.id)}><X size={13} />Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {smtpConfigs.length > 0 && (
            <div className="smtp-test-row">
              <input type="email" placeholder="Send test email to…" value={smtpTestTo}
                onChange={e => setSmtpTestTo(e.target.value)} className="smtp-test-input" />
              {smtpConfigs.filter(c => c.is_default).map(cfg => (
                <button key={cfg.id} className="ghost sm" onClick={() => testSmtp(cfg.id)}
                  disabled={smtpTesting === cfg.id}>
                  <Send size={13} />{smtpTesting === cfg.id ? "Sending…" : "Send test"}
                </button>
              ))}
            </div>
          )}

          {smtpConfigs.length < 4 && (
            smtpAdding ? (
              <form className="smtp-add-form panel" onSubmit={addSmtp}>
                <h3>Add email sender</h3>

                {/* Provider selector */}
                <div className="provider-tabs">
                  {[["brevo","Brevo (recommended)"],["gmail","Gmail"],["custom","Custom SMTP"]].map(([p, label]) => (
                    <button key={p} type="button"
                      className={`provider-tab ${smtpForm.provider === p ? "active" : ""}`}
                      onClick={() => setSmtpForm({ ...SMTP_BLANK, provider: p, label: smtpForm.label, senderName: smtpForm.senderName })}>
                      {label}
                    </button>
                  ))}
                </div>

                {/* Provider help boxes */}
                {smtpForm.provider === "brevo" && (
                  <div className="smtp-help-box">
                    <strong>Brevo setup (free · 300 emails/day · works everywhere)</strong>
                    <ol>
                      <li>Sign up free at <em>brevo.com</em></li>
                      <li>Go to <em>Settings → SMTP &amp; API → API Keys</em> → create a key</li>
                      <li>Go to <em>Settings → Senders &amp; IP</em> → add &amp; verify your sender email</li>
                      <li>Paste your API key and verified sender address below</li>
                    </ol>
                  </div>
                )}
                {smtpForm.provider === "gmail" && (
                  <div className="smtp-help-box">
                    <strong>Gmail App Password setup</strong>
                    <ol>
                      <li>Enable 2-step verification on your Google account</li>
                      <li>Go to <em>myaccount.google.com → Security → App Passwords</em></li>
                      <li>Generate an app password for "Mail"</li>
                      <li>Use the 16-character password below — <em>not</em> your regular Gmail password</li>
                    </ol>
                  </div>
                )}
                {smtpForm.provider === "custom" && (
                  <div className="smtp-help-box">
                    <strong>Custom SMTP server</strong>
                    <ol>
                      <li>Use your own mail server credentials</li>
                      <li>Common ports: <code>587</code> (STARTTLS) or <code>465</code> (SSL)</li>
                      <li>Note: Render free tier may block outbound SMTP — use Brevo if unsure</li>
                    </ol>
                  </div>
                )}

                <div className="smtp-form-grid">
                  <input required placeholder="Label (e.g. Main Gmail)" value={smtpForm.label}
                    onChange={e => setSmtpForm({ ...smtpForm, label: e.target.value })} />
                  <input required placeholder="Sender name (e.g. Grand Hotel)" value={smtpForm.senderName}
                    onChange={e => setSmtpForm({ ...smtpForm, senderName: e.target.value })} />
                  <input required type="email"
                    placeholder={smtpForm.provider === "brevo" ? "Verified sender email" : "Gmail address"}
                    value={smtpForm.email}
                    onChange={e => setSmtpForm({ ...smtpForm, email: e.target.value })} />
                  <input required type="password"
                    placeholder={smtpForm.provider === "brevo" ? "Brevo API key" : smtpForm.provider === "gmail" ? "App password (16 chars)" : "SMTP password"}
                    value={smtpForm.smtpPass}
                    onChange={e => setSmtpForm({ ...smtpForm, smtpPass: e.target.value })}
                    className="smtp-pass-input" />
                  {smtpForm.provider === "custom" && (<>
                    <input required placeholder="SMTP host (e.g. smtp.yourhost.com)" value={smtpForm.smtpHost}
                      onChange={e => setSmtpForm({ ...smtpForm, smtpHost: e.target.value })} />
                    <input required type="number" placeholder="Port (587)" value={smtpForm.smtpPort}
                      onChange={e => setSmtpForm({ ...smtpForm, smtpPort: +e.target.value })} />
                    <input required placeholder="SMTP username" value={smtpForm.smtpUser}
                      onChange={e => setSmtpForm({ ...smtpForm, smtpUser: e.target.value })} />
                  </>)}
                </div>
                <div className="row-btns">
                  <button className="primary" type="submit"><Check size={16} />Save</button>
                  <button className="ghost" type="button" onClick={() => { setSmtpAdding(false); setSmtpForm(SMTP_BLANK); }}>Cancel</button>
                </div>
              </form>
            ) : (
              <button className="ghost" onClick={() => setSmtpAdding(true)}><Plus size={16} />Add email config</button>
            )
          )}
        </div>
      )}

      {tab === "navigation" && (
        <div className="stack">
          <h2>Indoor navigation</h2>
          <p className="muted">Add waypoints and connections to enable step-by-step guest navigation.</p>
          <form className="inline-form" onSubmit={addWp}>
            <input required placeholder="Waypoint name" value={wpForm.name} onChange={e => setWpForm({ ...wpForm, name: e.target.value })} />
            <input type="number" placeholder="X" style={{ width: 60 }} value={wpForm.x} onChange={e => setWpForm({ ...wpForm, x: +e.target.value })} />
            <input type="number" placeholder="Y" style={{ width: 60 }} value={wpForm.y} onChange={e => setWpForm({ ...wpForm, y: +e.target.value })} />
            <input type="number" placeholder="Floor" style={{ width: 70 }} value={wpForm.floor} onChange={e => setWpForm({ ...wpForm, floor: +e.target.value })} />
            <input placeholder="Photo URL" value={wpForm.photoUrl} onChange={e => setWpForm({ ...wpForm, photoUrl: e.target.value })} />
            <button className="primary" type="submit"><Plus size={18} />Add</button>
          </form>
          <div className="table">
            {waypoints.map(wp => <div className="row" key={wp.id}><span>{wp.name}</span><span>Floor {wp.floor}</span><span>({wp.x},{wp.y})</span></div>)}
          </div>
          {waypoints.length >= 2 && (
            <form className="inline-form" onSubmit={addConn}>
              <select value={connForm.fromWaypointId} onChange={e => setConnForm({ ...connForm, fromWaypointId: e.target.value })}>
                <option value="">From…</option>
                {waypoints.map(wp => <option key={wp.id} value={wp.id}>{wp.name}</option>)}
              </select>
              <select value={connForm.toWaypointId} onChange={e => setConnForm({ ...connForm, toWaypointId: e.target.value })}>
                <option value="">To…</option>
                {waypoints.map(wp => <option key={wp.id} value={wp.id}>{wp.name}</option>)}
              </select>
              <input type="number" placeholder="m" style={{ width: 70 }} value={connForm.distance} onChange={e => setConnForm({ ...connForm, distance: +e.target.value })} />
              <button className="primary" type="submit"><Plus size={18} />Connect</button>
            </form>
          )}
          <div className="table">
            {connections.map(c => {
              const from = waypoints.find(w => w.id === c.from_waypoint_id)?.name;
              const to = waypoints.find(w => w.id === c.to_waypoint_id)?.name;
              return <div className="row" key={c.id}><span>{from}</span><ChevronRight size={13} /><span>{to}</span><span>{c.distance}m</span></div>;
            })}
          </div>
        </div>
      )}

      {tab === "qr" && (
        <div className="stack">
          <h2>Reception QR</h2>
          <p className="muted">Display this at your front desk. Guests scan it on arrival to notify staff. Refreshes every 30 minutes.</p>
          <QrBlock dataUrl={receptionQr} label={receptionExpiry !== null ? `Expires in ${receptionExpiry} min` : "Reception QR"} />
          <button className="ghost" onClick={() => {
            api.request("/api/settings/reception-qr").then(r => {
              setReceptionQr(r.qr_data_url);
              setReceptionExpiry(Math.max(0, Math.floor((new Date(r.expires_at) - Date.now()) / 60000)));
            }).catch(err => show(err.message, "error"));
          }}><QrCode size={15} />Refresh</button>

          <div className="divider" style={{ margin: "8px 0" }} />
          <h2>Checkout QR</h2>
          <p className="muted">Place this at the exit. Guests scan it to complete checkout.</p>
          <QrBlock dataUrl={checkoutQr} label="Checkout QR" />
          <button className="ghost" onClick={regenQr}><QrCode size={15} />Regenerate</button>
        </div>
      )}
    </div>
  );
}

// ── CheckinConfirmPanel ───────────────────────────────────────────────────────
// Shown after receptionist scans guest QR. Displays photo + booking details.
// Receptionist visually confirms identity then taps Confirm Check-In.

function CheckinConfirmPanel({ booking, onConfirm, onFlag, onClose, confirming }) {
  const facilitiesList = Array.isArray(booking.facilities) ? booking.facilities : [];
  return (
    <div className="stack">
      <div className="panel-header">
        <h2>Check-In Confirmation</h2>
        <button className="ghost sm" onClick={onClose}><X size={16} /></button>
      </div>

      {booking.selfie_url ? (
        <img
          src={booking.selfie_url}
          alt={booking.guest_name}
          className="checkin-guest-photo"
        />
      ) : (
        <div className="checkin-no-photo">
          <Users size={48} />
          <p>No photo uploaded</p>
        </div>
      )}

      {/* Guest + booking details */}
      <div className="checkin-detail-list">
        <div className="checkin-detail-row">
          <Users size={15} />
          <span><strong>{booking.guest_name}</strong></span>
        </div>
        <div className="checkin-detail-row">
          <BedDouble size={15} />
          <span>Room <strong>{booking.room_number}</strong> · {cap(booking.room_type)}</span>
        </div>
        <div className="checkin-detail-row">
          <CalendarDays size={15} />
          <span>Check-in <strong>{fmtDate(booking.check_in)}</strong></span>
        </div>
        <div className="checkin-detail-row">
          <CalendarDays size={15} />
          <span>Check-out <strong>{fmtDate(booking.check_out)}</strong></span>
        </div>
        {booking.package_name && (
          <div className="checkin-detail-row">
            <Star size={15} />
            <span>Package: <strong>{booking.package_name}</strong></span>
          </div>
        )}
        {facilitiesList.length > 0 && (
          <div className="checkin-detail-row">
            <Dumbbell size={15} />
            <span>Facilities: <strong>{facilitiesList.join(", ")}</strong></span>
          </div>
        )}
        {booking.special_notes && (
          <div className="checkin-detail-row muted">
            <span>Notes: {booking.special_notes}</span>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="checkin-action-btns">
        <button
          className="primary checkin-confirm-btn"
          onClick={onConfirm}
          disabled={confirming}
        >
          <Check size={18} />{confirming ? "Checking in…" : "Confirm Check-In"}
        </button>
        <button className="danger-btn" onClick={onFlag}>
          <AlertTriangle size={18} />Flag Issue
        </button>
      </div>
    </div>
  );
}

// ── Guest App ─────────────────────────────────────────────────────────────────

function GuestApp({ token }) {
  const [payload, setPayload] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState("home");
  const [lang, setLang] = useState("English");
  const [revoked, setRevoked] = useState(false);
  const { toast, show } = useToast();

  async function gReq(path, opts = {}) {
    const res = await fetch(`${API}/api/guest/${token}${path}`, {
      ...opts,
      headers: { "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "Error"); }
    if (res.status === 204) return null;
    return res.json();
  }

  function reload() {
    gReq("").then(d => { setPayload(d); setLoadError(""); }).catch(e => {
      setLoadError(e.message);
      show(e.message, "error");
    });
  }

  useEffect(() => { reload(); }, [token]);

  // Persist guest token so ScanReceptionPage / ScanFacilityPage can identify
  // the guest when the Android native camera opens a scan-reception or
  // scan-facility URL in a fresh browser tab.
  useEffect(() => {
    if (token && payload?.booking?.id) {
      localStorage.setItem("zynloc_guest_token", token);
      localStorage.setItem("zynloc_booking_id",  payload.booking.id);
    }
  }, [token, payload?.booking?.id]);

  // 10-second safety-net refresh — silent, catches missed Socket.IO events
  useEffect(() => {
    const id = setInterval(() => {
      gReq("").then(d => { setPayload(d); }).catch(() => {});
    }, 10_000);
    return () => clearInterval(id);
  }, [token]);

  useEffect(() => {
    if (!payload?.booking?.id) return;
    const socket = io(API);
    socket.emit("guest:join", payload.booking.id);
    socket.on("messages:new", reload);
    socket.on("checkin:confirmed", () => reload());
    socket.on("access:revoked", () => setRevoked(true));
    socket.on("access:restored", () => setRevoked(false));
    return () => socket.disconnect();
  }, [payload?.booking?.id]);

  if (!payload) {
    return (
      <main className="guest-shell" style={{ alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        {loadError
          ? <div className="stack" style={{ textAlign: "center", padding: 32 }}>
              <p className="error" style={{ fontSize: 16 }}>{loadError}</p>
              {loadError.includes("ended") && <p className="muted">Your stay has ended. Thank you for visiting!</p>}
              {loadError.includes("not found") && <p className="muted">This link is invalid. Please check your booking confirmation email.</p>}
            </div>
          : <p className="muted">Loading…</p>
        }
        <Toast toast={toast} />
      </main>
    );
  }

  const { booking, facilities = [], waypoints = [], connections = [], messages = [] } = payload;

  if (!booking.profile_status || booking.profile_status === "pending") {
    return <ProfileSetup token={token} booking={booking} onComplete={reload} lang={lang} show={show} toast={toast} />;
  }

  const TABS = [
    ["home", Hotel, t(lang, "welcome")],
    ["facilities", Dumbbell, t(lang, "facilities")],
    ["navigate", Navigation, t(lang, "navigate")],
    ["services", Zap, t(lang, "services")],
    ["messages", MessageSquare, t(lang, "messages")],
    ["checkout", DoorOpen, t(lang, "checkout")],
  ];

  return (
    <main className="guest-shell">
      {revoked && (
        <div className="revoked-overlay">
          <XCircle size={56} color="var(--red)" />
          <h2>Access Revoked</h2>
          <p>Your access has been revoked by the hotel. Please contact the front desk for assistance.</p>
          <a href={`tel:${booking.reception_phone || "0"}`} className="primary" style={{ textDecoration: "none", marginTop: 8 }}>
            <PhoneCall size={16} />Call Reception
          </a>
        </div>
      )}
      {booking.cover_photo_url && <div className="guest-cover" style={{ backgroundImage: `url(${booking.cover_photo_url})` }} />}
      <div className="guest-body">
        {tab === "home" && <GuestHome booking={booking} gReq={gReq} show={show} lang={lang} setLang={setLang} />}
        {tab === "facilities" && <GuestFacilities facilities={facilities} gReq={gReq} show={show} lang={lang} />}
        {tab === "navigate" && <GuestNavigate waypoints={waypoints} connections={connections} lang={lang} show={show} />}
        {tab === "services" && <GuestServices gReq={gReq} show={show} lang={lang} />}
        {tab === "messages" && <GuestMessages messages={messages} gReq={gReq} reload={reload} show={show} lang={lang} booking={booking} />}
        {tab === "checkout" && <GuestCheckout booking={booking} gReq={gReq} show={show} lang={lang} />}
      </div>

      <nav className="bottom-nav">
        {TABS.map(([key, Icon, label]) => (
          <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            <Icon size={20} /><span>{label}</span>
          </button>
        ))}
      </nav>

      <Toast toast={toast} />
    </main>
  );
}

function ProfileSetup({ token, booking, onComplete, lang, show, toast }) {
  const [name, setName] = useState(booking.guest_name || "");
  const [selfie, setSelfie] = useState(null);
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!selfie) { show("Please upload a photo first", "error"); return; }
    setSaving(true);
    try {
      const res = await fetch(`${API}/api/guest/${token}/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, selfieUrl: selfie })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      show("Profile saved!", "success");
      onComplete();
    } catch (err) { show(err.message, "error"); setSaving(false); }
  }

  return (
    <main className="guest-shell profile-setup">
      <div className="profile-card">
        <div className="brand-lockup"><Hotel size={22} /><span>{booking.hotel_name}</span></div>
        <h1>{t(lang, "profileSetup")}</h1>
        <p className="muted">{t(lang, "profileSubtitle")}</p>
        <form className="stack" onSubmit={submit}>
          <input required placeholder={t(lang, "yourName")} value={name} onChange={e => setName(e.target.value)} />
          <SelfieCapture onCapture={setSelfie} label={t(lang, "takeSelfie")} hint={t(lang, "selfieHint")} />
          {selfie && !saving && (
            <button className="primary" type="submit"><Check size={18} />{t(lang, "confirmProfile")}</button>
          )}
          {saving && <p className="hint">Saving profile…</p>}
        </form>
      </div>
      <Toast toast={toast} />
    </main>
  );
}

function GuestHome({ booking, gReq, show, lang, setLang }) {
  const [checkinQr, setCheckinQr] = useState(null);
  const [loadingQr, setLoadingQr] = useState(false);
  const [scanningReception, setScanningReception] = useState(false);
  const [waitingConfirm, setWaitingConfirm] = useState(false);

  async function loadQr() {
    setLoadingQr(true);
    try { const r = await gReq("/checkin-qr"); setCheckinQr(r); }
    catch (err) { show(err.message, "error"); }
    setLoadingQr(false);
  }

  useEffect(() => { if (booking.status !== "current") loadQr(); }, []);

  // Clear waiting screen when booking status changes to current (checkin confirmed)
  useEffect(() => { if (booking.status === "current") setWaitingConfirm(false); }, [booking.status]);

  useEffect(() => {
    if (!checkinQr?.expires_at) return;
    const delay = new Date(checkinQr.expires_at) - Date.now();
    if (delay <= 0) return;
    const tid = setTimeout(loadQr, delay + 1000);
    return () => clearTimeout(tid);
  }, [checkinQr]);

  async function handleReceptionScan(qrData) {
    setScanningReception(false);
    const token = qrData.includes("/reception-scan/") ? qrData.split("/reception-scan/").pop() : qrData;
    try {
      await gReq("/scan-reception", { method: "POST", body: { receptionToken: token } });
      setWaitingConfirm(true);
      show("Reception notified! Please wait.", "success");
    } catch (err) { show(err.message, "error"); }
  }

  const expiresIn = checkinQr ? Math.max(0, Math.floor((new Date(checkinQr.expires_at) - Date.now()) / 60000)) : null;

  return (
    <div className="guest-home">
      <div className="guest-hero">
        {booking.logo_url && <img src={booking.logo_url} alt="Hotel logo" className="hotel-logo" />}
        <h1>{t(lang, "welcome")}, {booking.guest_name?.split(" ")[0]}</h1>
        <p className="hotel-name">{booking.hotel_name}</p>
        <p className="room-tag">{t(lang, "room")} <strong>{booking.room_number}</strong></p>
        <p className="dates">{t(lang, "checkIn")}: {fmtDate(booking.check_in)} &nbsp;·&nbsp; {t(lang, "checkOut")}: {fmtDate(booking.check_out)}</p>
      </div>

      {booking.status === "current" ? (
        <div className="checkin-badge">
          <CheckCircle size={36} />
          <strong>{t(lang, "checkInConfirmed")}</strong>
          <p className="muted" style={{ fontSize: 13 }}>Welcome! Your room is ready.</p>
        </div>
      ) : waitingConfirm ? (
        <div className="waiting-screen">
          <div className="waiting-spinner" />
          <h3>Reception Notified</h3>
          <p>Please wait at the front desk. Staff will confirm your check-in shortly.</p>
        </div>
      ) : (
        <div className="checkin-section">
          <h2>{t(lang, "checkInReady")}</h2>
          <p className="muted">Option 1: Show this QR to reception staff.</p>
          {checkinQr ? (
            <div className="checkin-qr">
              <QrBlock dataUrl={checkinQr.qr_data_url} label={`Valid ${expiresIn} min`} />
              <button className="ghost sm" onClick={loadQr} disabled={loadingQr}>Refresh</button>
            </div>
          ) : (
            <button className="primary" onClick={loadQr} disabled={loadingQr}>
              <QrCode size={18} />{loadingQr ? "Loading…" : t(lang, "scanQr")}
            </button>
          )}
          <div className="reception-scan-section">
            <h3>Option 2: Scan hotel reception QR</h3>
            <p className="muted" style={{ fontSize: 12 }}>Point your camera at the QR code displayed at the front desk.</p>
            <button className="primary" onClick={() => setScanningReception(true)}>
              <QrCode size={18} />Scan Reception QR
            </button>
          </div>
          {scanningReception && <QrScanner onScan={handleReceptionScan} onClose={() => setScanningReception(false)} bookings={[]} />}
        </div>
      )}

      <div className="home-actions">
        <a className="emergency-link" href={`tel:${booking.reception_phone || "0"}`}>
          <PhoneCall size={15} />{t(lang, "emergency")}
        </a>
        <div className="lang-row">
          <Globe size={14} />
          <select value={lang} onChange={e => setLang(e.target.value)}>
            {LANGUAGES.map(l => <option key={l}>{l}</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}

function GuestFacilities({ facilities, gReq, show, lang }) {
  const [scanning, setScanning] = useState(false);
  const [accessResult, setAccessResult] = useState(null);

  async function handleScan(qrData) {
    setScanning(false);
    try {
      const result = await gReq("/facility-scan", { method: "POST", body: { facilityToken: qrData } });
      setAccessResult(result);
      show(result.granted ? t(lang, "accessGranted") : t(lang, "accessDenied"), result.granted ? "success" : "error");
    } catch (err) { show(err.message, "error"); }
  }

  return (
    <div className="guest-facilities">
      <h2>{t(lang, "facilities")}</h2>
      <div className="facility-list">
        {facilities.map(f => (
          <article className={`facility-card ${f.included ? "included" : "excluded"}`} key={f.id}>
            <Dumbbell size={22} />
            <div>
              <h3>{f.name}</h3>
              <p>{f.included ? t(lang, "included") : t(lang, "notIncluded")}</p>
            </div>
            {f.included && <span className="access-badge"><Check size={13} /></span>}
          </article>
        ))}
        {!facilities.length && <p className="muted">{t(lang, "noFacilities")}</p>}
      </div>
      <button className="primary scan-btn" onClick={() => setScanning(true)}>
        <QrCode size={18} />{t(lang, "scanFacility")}
      </button>
      {scanning && <QrScanner onScan={handleScan} onClose={() => setScanning(false)} bookings={[]} />}
      {accessResult && (
        <div className={`access-result ${accessResult.granted ? "granted" : "denied"}`}>
          {accessResult.granted ? <CheckCircle size={44} /> : <XCircle size={44} />}
          <strong>{accessResult.granted ? t(lang, "accessGranted") : t(lang, "accessDenied")}</strong>
          <p>{accessResult.granted ? t(lang, "enjoyVisit") : t(lang, "notInPackage")}</p>
          <button className="ghost" onClick={() => setAccessResult(null)}><X size={15} /></button>
        </div>
      )}
    </div>
  );
}

function GuestNavigate({ waypoints, connections, lang, show }) {
  const [dest, setDest] = useState("");
  const [route, setRoute] = useState(null);
  const [step, setStep] = useState(0);

  function navigate() {
    if (!dest || !waypoints.length) { show(t(lang, "noNavigation"), "error"); return; }
    const lobby = waypoints.find(w => /lobby|reception|entrance/i.test(w.name)) || waypoints[0];
    const result = findPath(waypoints, connections, lobby.id, dest);
    if (!result || !result.steps.length) { show(t(lang, "noNavigation"), "error"); return; }
    setRoute(result); setStep(0);
  }

  if (!waypoints.length) return <div className="guest-navigate"><p className="muted">{t(lang, "noNavigation")}</p></div>;

  return (
    <div className="guest-navigate">
      <h2>{t(lang, "navigate")}</h2>
      <div className="nav-picker">
        <select value={dest} onChange={e => setDest(e.target.value)}>
          <option value="">{t(lang, "selectDestination")}</option>
          {waypoints.map(wp => <option key={wp.id} value={wp.id}>{wp.name}</option>)}
        </select>
        <button className="primary" onClick={navigate} disabled={!dest}><Navigation size={18} />Go</button>
      </div>

      {route && (
        <div className="nav-steps">
          <div className="nav-progress">
            <div className="progress-fill" style={{ width: `${Math.round((step + 1) / route.steps.length * 100)}%` }} />
          </div>
          <div className="step-card">
            {route.steps[step]?.waypoint?.photo_url && (
              <img src={route.steps[step].waypoint.photo_url} alt="Step" className="step-photo" />
            )}
            <div className="step-num">{t(lang, "step")} {step + 1} {t(lang, "of")} {route.steps.length}</div>
            <h3>{route.steps[step]?.waypoint?.name}</h3>
            <p>{route.steps[step]?.hint || ""}</p>
          </div>
          <div className="step-nav">
            <button className="ghost" onClick={() => setStep(s => Math.max(0, s - 1))} disabled={step === 0}>←</button>
            {step < route.steps.length - 1
              ? <button className="primary" onClick={() => setStep(s => s + 1)}>{t(lang, "nextStep")} →</button>
              : <div className="arrived"><CheckCircle size={18} /> {t(lang, "arrived")}</div>
            }
          </div>
        </div>
      )}
    </div>
  );
}

function GuestServices({ gReq, show, lang }) {
  const [custom, setCustom] = useState("");
  const [sent, setSent] = useState(null);

  async function request(type, description = "") {
    try {
      await gReq("/service-requests", { method: "POST", body: { type, description } });
      setSent(type); show(t(lang, "requestSent"), "success");
      setTimeout(() => setSent(null), 3000);
    } catch (err) { show(err.message, "error"); }
  }

  const SERVICES = [
    ["room_cleaning", t(lang, "requestCleaning"), Sparkles],
    ["extra_towels", t(lang, "requestTowels"), Star],
    ["maintenance", t(lang, "requestMaintenance"), Zap],
    ["food_drinks", t(lang, "requestFood"), Truck],
  ];

  return (
    <div className="guest-services">
      <h2>{t(lang, "services")}</h2>
      <div className="service-grid">
        {SERVICES.map(([type, label, Icon]) => (
          <button key={type} className={`service-btn ${sent === type ? "sent" : ""}`} onClick={() => request(type)}>
            <Icon size={28} /><span>{label}</span>
            {sent === type && <span className="sent-mark"><Check size={14} /></span>}
          </button>
        ))}
      </div>
      <div className="custom-request">
        <input placeholder={t(lang, "requestCustom") + "…"} value={custom} onChange={e => setCustom(e.target.value)} />
        <button className="primary" onClick={() => { if (custom.trim()) { request("custom", custom); setCustom(""); } }}>
          <Send size={16} />{t(lang, "send")}
        </button>
      </div>
    </div>
  );
}

function GuestMessages({ messages, gReq, reload, show, lang, booking }) {
  const [body, setBody] = useState("");
  const endRef = useRef(null);
  const hotelName = booking?.hotel_name || "Hotel";

  // Messages arrive newest-first from API — display oldest first
  const msgs = useMemo(() => [...messages].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)), [messages]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs.length]);

  async function send(e) {
    e.preventDefault();
    if (!body.trim()) return;
    try { await gReq("/messages", { method: "POST", body: { body } }); setBody(""); reload(); }
    catch (err) { show(err.message, "error"); }
  }

  return (
    <div className="guest-chat-shell">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="guest-chat-header">
        <div className="guest-chat-hotel-avatar">
          {booking?.logo_url
            ? <img src={booking.logo_url} alt={hotelName} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} />
            : <Hotel size={18} />
          }
        </div>
        <div>
          <strong>{hotelName}</strong>
          <br />
          <small style={{ color: "var(--muted)", fontSize: 11 }}>Hotel Staff</small>
        </div>
      </div>

      {/* ── Message list ────────────────────────────────────────────── */}
      <div className="guest-chat-messages">
        {msgs.length === 0 && (
          <div className="guest-chat-empty">
            <MessageSquare size={32} style={{ color: "var(--muted)" }} />
            <p className="muted">No messages yet. Say hello!</p>
          </div>
        )}
        {msgs.map(m => {
          const isGuest = m.sender === "guest";
          const senderLabel = isGuest
            ? (t(lang, "you") || "You")
            : (m.sender_display_name || m.staff_display_name || m.staff_name || hotelName);
          return (
            <div key={m.id} className={`guest-chat-msg ${isGuest ? "outgoing" : "incoming"}`}>
              {m.broadcast && !isGuest && (
                <span className="broadcast-label">📢 BROADCAST</span>
              )}
              <span className="guest-chat-sender">{senderLabel}</span>
              <div className={`guest-chat-bubble ${isGuest ? "outgoing" : "incoming"} ${m.broadcast ? "broadcast" : ""}`}>
                {m.body}
              </div>
              <span className="guest-chat-time">{fmtTime(m.created_at)}</span>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {/* ── Input bar ───────────────────────────────────────────────── */}
      <form className="guest-chat-input" onSubmit={send}>
        <input
          placeholder={t(lang, "typeMessage") || "Type a message…"}
          value={body}
          onChange={e => setBody(e.target.value)}
        />
        <button type="submit" className="guest-chat-send" disabled={!body.trim()}>
          <Send size={18} />
        </button>
      </form>
    </div>
  );
}

function GuestCheckout({ booking, gReq, show, lang }) {
  const [scanning, setScanning] = useState(false);
  const [done, setDone] = useState(booking.status === "checked_out");

  async function manualCheckout() {
    try { await gReq("/checkout", { method: "POST" }); setDone(true); show(t(lang, "checkoutDone"), "success"); }
    catch (err) { show(err.message, "error"); }
  }

  async function handleScan(qrData) {
    setScanning(false);
    try { await gReq("/checkout-scan", { method: "POST", body: { checkoutToken: qrData } }); setDone(true); show(t(lang, "checkoutDone"), "success"); }
    catch (err) { show(err.message, "error"); }
  }

  if (done) return (
    <div className="checkout-done">
      <CheckCircle size={64} />
      <h2>{t(lang, "checkoutDone")}</h2>
      <p>We hope you enjoyed your stay!</p>
    </div>
  );

  return (
    <div className="guest-checkout">
      <h2>{t(lang, "checkoutTitle")}</h2>
      <p className="muted">{t(lang, "checkoutScan")}</p>
      <div className="checkout-actions">
        <button className="primary" onClick={() => setScanning(true)}><QrCode size={20} />{t(lang, "checkoutScan")}</button>
        <button className="ghost" onClick={manualCheckout}><Check size={18} />{t(lang, "checkoutConfirm")}</button>
      </div>
      {scanning && <QrScanner onScan={handleScan} onClose={() => setScanning(false)} bookings={[]} />}
    </div>
  );
}

// ── mount ─────────────────────────────────────────────────────────────────────

createRoot(document.getElementById("root")).render(<App />);
