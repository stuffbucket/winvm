/**
 * The app's menu: Base UI's Menu (focus, typeahead, keyboard, positioning,
 * dismissal) in the window's style. The same wrapper shape as maximal's
 * design system (packages/maximal-design-system/src/components/overlays/menu.tsx):
 * a root that takes its trigger, then groups, items, radio items and
 * separators, each a styled Base UI part. Styles: `.menu*` in styles.css.
 */
import { Menu as BaseMenu } from "@base-ui/react/menu"
import type { ComponentPropsWithRef, ReactElement, ReactNode } from "react"

import { cx } from "./cx"
import { Icon } from "./Icon"

export interface MenuRootProps extends Omit<ComponentPropsWithRef<typeof BaseMenu.Root>, "children"> {
  /** The element that opens the menu; Base UI gives it the trigger's props (aria-haspopup, aria-expanded…). */
  readonly trigger: ReactElement
  readonly children: ReactNode
  readonly align?: ComponentPropsWithRef<typeof BaseMenu.Positioner>["align"]
  readonly side?: ComponentPropsWithRef<typeof BaseMenu.Positioner>["side"]
  readonly sideOffset?: number
  /** Names the popup for assistive tech, when its group label doesn't. */
  readonly label?: string
}

export function MenuRoot({ trigger, children, align = "start", side = "bottom", sideOffset = 4, label, ...props }: MenuRootProps): JSX.Element {
  return (
    <BaseMenu.Root {...props}>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner className="menu-positioner" align={align} side={side} sideOffset={sideOffset}>
          <BaseMenu.Popup className="menu" aria-label={label}>
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

export function MenuGroup({ label, children }: { readonly label?: ReactNode; readonly children: ReactNode }): JSX.Element {
  return (
    <BaseMenu.Group className="menu__group">
      {label !== undefined && <BaseMenu.GroupLabel className="menu__heading">{label}</BaseMenu.GroupLabel>}
      {children}
    </BaseMenu.Group>
  )
}

interface ItemContentProps {
  readonly children: ReactNode
  readonly leading?: ReactNode
  /** Quiet text at the end of the row: a state, a shortcut. */
  readonly trailing?: ReactNode
}

function ItemContent({ children, leading, trailing }: ItemContentProps): JSX.Element {
  return (
    <>
      <span className="menu-item__leading">{leading}</span>
      <span className="menu-item__label">{children}</span>
      {trailing !== undefined && <span className="menu-item__trailing">{trailing}</span>}
    </>
  )
}

export interface MenuItemProps extends Omit<ComponentPropsWithRef<typeof BaseMenu.Item>, "children" | "className">, ItemContentProps {
  readonly tone?: "default" | "danger"
}

export function MenuItem({ children, leading, trailing, tone = "default", ...props }: MenuItemProps): JSX.Element {
  return (
    <BaseMenu.Item {...props} className={cx("menu-item", tone === "danger" && "menu-item--danger")}>
      <ItemContent leading={leading} trailing={trailing}>
        {children}
      </ItemContent>
    </BaseMenu.Item>
  )
}

export type MenuRadioGroupProps = ComponentPropsWithRef<typeof BaseMenu.RadioGroup>

/** One choice among several (the current machine): a check on the chosen one. */
export function MenuRadioGroup(props: MenuRadioGroupProps): JSX.Element {
  return <BaseMenu.RadioGroup {...props} />
}

export interface MenuRadioItemProps extends Omit<ComponentPropsWithRef<typeof BaseMenu.RadioItem>, "children" | "className">, Omit<ItemContentProps, "leading"> {}

export function MenuRadioItem({ children, trailing, ...props }: MenuRadioItemProps): JSX.Element {
  return (
    <BaseMenu.RadioItem {...props} className="menu-item">
      <ItemContent
        leading={
          <BaseMenu.RadioItemIndicator className="menu-item__check" keepMounted>
            <Icon name="check" />
          </BaseMenu.RadioItemIndicator>
        }
        trailing={trailing}
      >
        {children}
      </ItemContent>
    </BaseMenu.RadioItem>
  )
}

export function MenuSeparator(): JSX.Element {
  return <BaseMenu.Separator className="menu__separator" />
}
