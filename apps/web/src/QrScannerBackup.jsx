// iPhone working backup — restore this if new implementation breaks iPhone
// This is the jsqr file-input implementation that works on iPhone Safari.
// To restore: copy decodeQRFromFile + QrScanner from this file back into main.jsx.

import React, { useState } from "react";
import { Camera, Upload } from "lucide-react";

async function decodeQRFromFile(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = async () => {
      const canvas = document.createElement("canvas");
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      const imageData = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      const { default: jsQR } = await import("jsqr");
      const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" })
                || jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "onlyInvert" });
      code ? resolve(code.data) : reject(new Error("No QR code detected"));
    };
    img.onerror = () => reject(new Error("Image failed to load"));
    img.src = dataUrl;
  });
}

export function QrScannerBackup({ onScan, onClose, bookings = [] }) {
  const [status, setStatus] = useState("idle");
  const [error,  setError]  = useState(null);
  const [search, setSearch] = useState("");
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

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

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus("scanning");
    setError(null);
    try {
      const result = await decodeQRFromFile(file);
      setStatus("success");
      onScan(result);
    } catch {
      setStatus("error");
      setError("QR code not detected. Make sure the QR code fills most of the photo and is well lit. Try again.");
    }
  }

  return (
    <div className="qr-scanner-shell">
      <div className="qr-file-ui">
        {status === "scanning" && <p className="qr-loading">Reading QR code…</p>}
        {error && <p className="qr-error">{error}</p>}
        <label className="qr-capture-label primary">
          <Camera size={20} /><span>Take Photo of QR Code</span>
          <input type="file" accept="image/*" capture="environment"
            onChange={handleFileChange} style={{ display: "none" }} />
        </label>
        <label className="qr-capture-label secondary">
          <Upload size={18} /><span>Upload from Gallery</span>
          <input type="file" accept="image/*"
            onChange={handleFileChange} style={{ display: "none" }} />
        </label>
        <p className="qr-hint">Point camera at the QR code and take a clear photo</p>
        <button className="secondary" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
