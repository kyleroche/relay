import { ImageResponse } from "next/og";

export const alt = "relay — your coding-agent subscriptions, working as one system";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "#171718",
          color: "#f2f2f0",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none">
            <circle cx="5" cy="12" r="3" fill="#7fb3dc" />
            <circle cx="19" cy="12" r="3" fill="#7fb3dc" opacity="0.55" />
            <path d="M8 12h8" stroke="#7fb3dc" strokeWidth="2" strokeLinecap="round" />
            <path d="M13 9l3 3-3 3" stroke="#7fb3dc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div style={{ fontSize: 44, fontWeight: 600 }}>relay</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ fontSize: 60, fontWeight: 600, lineHeight: 1.1, letterSpacing: -1 }}>Your coding-agent subscriptions, working as one system.</div>
          <div style={{ fontSize: 28, color: "#a7a7a3", lineHeight: 1.4 }}>
            GitHub issues as the task bus · runners on your machines · shared memory · a feed of everything agents did and what it cost.
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 24, color: "#7fb3dc" }}>
          <span>harness.kyro.house</span>
          <span style={{ color: "#a7a7a3" }}>open source · Apache-2.0</span>
        </div>
      </div>
    ),
    size,
  );
}
