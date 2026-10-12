import { ImageResponse } from "next/og";
import { APP_NAME, APP_TAGLINE } from "@/lib/config";

export const alt = `${APP_NAME}: ${APP_TAGLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The preview shown when a link to the app is shared. Drawn in code, like the app icon. */
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
          padding: 80,
          background: "#0B0E13",
          color: "#EEF1F5",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: "50%",
              border: "10px solid #C8F560",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#EEF1F5" }} />
          </div>
          <div style={{ display: "flex", fontSize: 56, fontWeight: 700, letterSpacing: 2 }}>{APP_NAME}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div style={{ display: "flex", fontSize: 76, fontWeight: 700, lineHeight: 1.1 }}>Run your Beyblade X tournament on auto-pilot.</div>
          <div style={{ display: "flex", fontSize: 38, color: "#C8F560" }}>{APP_TAGLINE}</div>
        </div>
      </div>
    ),
    size,
  );
}
