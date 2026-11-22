declare module "@winvm/novnc/core/rfb.js" {
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      url: string,
      options?: {
        readonly credentials?: { readonly password?: string }
        readonly wsProtocols?: readonly string[]
      },
    )
    scaleViewport: boolean
    clipViewport: boolean
    resizeSession: boolean
    background: string
    focusOnClick: boolean
    viewOnly: boolean
    disconnect(): void
    sendKey(keysym: number, code: string, down?: boolean): void
    sendCredentials(credentials: { readonly password: string }): void
    clipboardPasteFrom(text: string): void
    readonly _clipboardServerCapabilitiesFormats?: Readonly<
      Record<number, boolean>
    >
    readonly _sock: unknown
    readonly _screenID?: number
    readonly _screenFlags?: number
    readonly _display: {
      flip(fromQueue?: boolean): void
      readonly _renderQ: readonly unknown[]
      readonly _fbWidth: number
      readonly _fbHeight: number
    }
    readonly _keyboard: {
      _allKeysUp(): void
    }
    static readonly messages: {
      setDesktopSize(
        sock: unknown,
        width: number,
        height: number,
        id: number,
        flags: number,
      ): void
    }
  }
}

declare module "@winvm/novnc/core/input/util.js" {
  export function getKeycode(event: KeyboardEvent): string
  export function getKeysym(event: KeyboardEvent): number | null
}
