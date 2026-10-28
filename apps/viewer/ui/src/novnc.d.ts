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
    /** Private in noVNC, read to send SetDesktopSize ourselves (see Screen.tsx). */
    readonly _sock: unknown
    readonly _screenID?: number
    readonly _screenFlags?: number
    static readonly messages: {
      setDesktopSize(sock: unknown, width: number, height: number, id: number, flags: number): void
    }
  }
}
