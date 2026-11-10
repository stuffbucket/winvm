import { useId } from "react"

/** Decorative fallback, never a fabricated guest screen. No taskbar or desktop UI. */
export function Wallpaper(): JSX.Element {
  const id = useId()
  return (
    <svg className="checkpoint__wallpaper" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-room`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="var(--wallpaper-ink)" />
          <stop offset="1" stopColor="var(--wallpaper-sage)" />
        </linearGradient>
        <linearGradient id={`${id}-sand`} x1="0" y1="0" x2="0.8" y2="1">
          <stop stopColor="var(--wallpaper-sand)" />
          <stop offset="1" stopColor="var(--wallpaper-clay)" />
        </linearGradient>
        <linearGradient id={`${id}-fold`} x1="0" y1="0" x2="0.4" y2="1">
          <stop stopColor="var(--wallpaper-sage)" />
          <stop offset="1" stopColor="var(--wallpaper-ink)" />
        </linearGradient>
      </defs>
      <path fill={`url(#${id}-room)`} d="M0 0h1600v1000H0z" />
      <path fill={`url(#${id}-sand)`} d="M-100 240C360 650 860-120 1710 130L1710 1080H-100Z" />
      <path fill={`url(#${id}-fold)`} d="M-100 490C480 1060 950 170 1710 460L1710 1080H-100Z" />
      <path fill={`url(#${id}-sand)`} d="M-100 830C510 370 930 1150 1710 680L1710 1080H-100Z" />
      <path fill={`url(#${id}-fold)`} d="M-100 1070C430 560 1040 1180 1710 920L1710 1080H-100Z" />
    </svg>
  )
}
