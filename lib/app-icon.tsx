import { ImageResponse } from "next/og";

/** The app icon, drawn in code (a stadium seen from above) so there are no binary assets to maintain. */
export function appIcon(size: number) {
  const ring = Math.round(size * 0.09);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0B0E13" }}>
        <div
          style={{
            width: size * 0.68,
            height: size * 0.68,
            borderRadius: "50%",
            border: `${ring}px solid #C8F560`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ width: size * 0.2, height: size * 0.2, borderRadius: "50%", background: "#EEF1F5" }} />
        </div>
      </div>
    ),
    { width: size, height: size },
  );
}
