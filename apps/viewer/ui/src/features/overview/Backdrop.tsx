import { type JSX, useState } from "react"

import { cx } from "../../components/cx"

function Wallpaper(): JSX.Element {
  return (
    <svg
      className="backdrop__wallpaper"
      viewBox="0 0 1600 1000"
      preserveAspectRatio="xMidYMid slice"
      focusable="false"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="wallpaper-sky" x1="0" y1="0" x2="0" y2="1">
          <stop
            offset="0"
            style={{ stopColor: "var(--backdrop-glow-accent)" }}
          />
          <stop offset="1" style={{ stopColor: "var(--backdrop-base)" }} />
        </linearGradient>
        <radialGradient id="wallpaper-sun" cx="0.5" cy="0.5" r="0.5">
          <stop
            offset="0"
            style={{ stopColor: "var(--brand)", stopOpacity: 1 }}
          />
          <stop
            offset="0.55"
            style={{
              stopColor: "var(--backdrop-glow-brand)",
              stopOpacity: 0.85,
            }}
          />
          <stop
            offset="1"
            style={{ stopColor: "var(--backdrop-glow-brand)", stopOpacity: 0 }}
          />
        </radialGradient>
      </defs>
      <rect width="1600" height="1000" fill="url(#wallpaper-sky)" />
      <circle cx="1130" cy="400" r="380" fill="url(#wallpaper-sun)" />
      <path
        d="M-100 700 C 240 470 560 600 820 440 S 1340 250 1700 380 L1700 1100 L-100 1100 Z"
        style={{ fill: "var(--link)", fillOpacity: 0.8 }}
      />
      <path
        d="M-100 820 C 300 640 640 780 940 610 S 1360 520 1700 590 L1700 1100 L-100 1100 Z"
        style={{ fill: "var(--accent)", fillOpacity: 0.9 }}
      />
      <path
        d="M-100 930 C 280 800 700 900 1020 790 S 1400 740 1700 800 L1700 1100 L-100 1100 Z"
        style={{ fill: "var(--backdrop-base)", fillOpacity: 0.55 }}
      />
    </svg>
  )
}

function Picture({ url }: { readonly url: string }): JSX.Element {
  const [ready, setReady] = useState(false)
  return (
    <img
      className={cx("backdrop__picture", ready && "backdrop__picture--ready")}
      src={url}
      alt=""
      draggable={false}
      onLoad={() => {
        setReady(true)
      }}
    />
  )
}

export function Backdrop({
  picture,
}: {
  readonly picture: string | null
}): JSX.Element {
  return (
    <div className="backdrop" aria-hidden="true">
      <div className="backdrop__layers">
        <Wallpaper />
        {picture !== null && <Picture key={picture} url={picture} />}
      </div>
    </div>
  )
}
