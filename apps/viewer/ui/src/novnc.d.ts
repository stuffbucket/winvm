declare module "novnc/core/rfb.js" {
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      url: string,
      options?: { readonly credentials?: { readonly password?: string }; readonly wsProtocols?: readonly string[] },
    )
    scaleViewport: boolean
    clipViewport: boolean
    resizeSession: boolean
    background: string
    focusOnClick: boolean
    disconnect(): void
    sendCredentials(credentials: { readonly password: string }): void
    /** Sends text to the server's clipboard: extended clipboard (UTF-8) once the server has said it can, else Latin-1. */
    clipboardPasteFrom(text: string): void
    /**
     * Private in noVNC: the extended-clipboard formats the server announced
     * (1 is text), empty until its caps arrive just after connecting; read so
     * the first paste goes as UTF-8 (see Screen.tsx).
     */
    readonly _clipboardServerCapabilitiesFormats?: Readonly<Record<number, boolean>>
    /** Private in noVNC, read to send SetDesktopSize ourselves (see Screen.tsx). */
    readonly _sock: unknown
    readonly _screenID?: number
    readonly _screenFlags?: number
    /**
     * Private in noVNC: the framebuffer's drawing. `flip` ends each update
     * (queued while images decode, then called again with `fromQueue`); the
     * viewer wraps it to know when a new size has been drawn in full.
     */
    readonly _display: {
      flip(fromQueue?: boolean): void
      readonly _renderQ: readonly unknown[]
      readonly _fbWidth: number
      readonly _fbHeight: number
    }
    static readonly messages: {
      setDesktopSize(sock: unknown, width: number, height: number, id: number, flags: number): void
    }
  }
}
