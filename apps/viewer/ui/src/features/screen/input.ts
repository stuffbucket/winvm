/**
 * Who has the keyboard and the pointer over the screen. Pure, so the tests
 * drive it.
 *
 * The guest gets input only while it is live and answering: Windows running,
 * no verb under way (starting, restarting, saving, loading, pausing, locking,
 * waking: all of them busy). In every other phase the frame is a picture, not a
 * window into the machine, and the Mac keeps what is its own:
 *
 * - the pointer: no event reaches noVNC, and the Mac's arrow shows over the
 *   frame, never the guest's cursor and never a hidden one;
 * - the keyboard: nothing is captured (one that was is released, and says so),
 *   no key is swallowed, and none is sent;
 * - the buttons that send input (Capture Keyboard, Send Windows Key, Send
 *   Ctrl-Alt-Delete) are off, and say why.
 *
 * Asleep is the one exception that listens: its first key wakes the machine
 * (held.ts), and goes no further.
 */
import type { Phase } from "../../model"

export interface InputRule {
  /** Mouse, wheel and keys go to the guest. */
  readonly forward: boolean
  /** Over the frame: the guest's own cursor, or the Mac's arrow. */
  readonly cursor: "guest" | "arrow"
  /** Keyboard capture can be engaged, or is released (and stays so until it is asked for again). */
  readonly capture: "allowed" | "released"
  /** A click on the frame takes keyboard focus, so a key can wake an asleep machine. */
  readonly focusOnClick: boolean
  /** An i18n key saying why the guest takes no input; null when it does. */
  readonly why: string | null
  /** An i18n key for the quiet note beside the toolbar when this released a capture; null when it can't. */
  readonly released: string | null
}

const LIVE: InputRule = { forward: true, cursor: "guest", capture: "allowed", focusOnClick: true, why: null, released: null }

const off = (name: string, focusOnClick = false): InputRule => ({
  forward: false,
  cursor: "arrow",
  capture: "released",
  focusOnClick,
  why: `input.why.${name}`,
  released: `input.released.${name}`,
})

/** `busy`: a verb is under way (or there is no word yet from the machine, or the host isn't ready). */
export function inputRule(phase: Phase | null | undefined, busy: boolean): InputRule {
  switch (phase) {
    case "running":
      return busy ? off("busy") : LIVE
    case "starting":
      return off("starting")
    case "paused":
      return off("paused")
    case "asleep":
      return off("asleep", true)
    case "stopped":
    case "stowed":
    case "missing":
    case null:
    case undefined:
      return off("off")
  }
}
