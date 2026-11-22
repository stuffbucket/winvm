import { Menu as BaseMenu } from "@base-ui/react/menu"
import type { ComponentPropsWithRef, JSX, ReactElement, ReactNode } from "react"

import { px, spacing } from "../styles/theme"
import { cx } from "./cx"
import { Icon } from "./Icon"

export interface MenuRootProps
  extends Omit<ComponentPropsWithRef<typeof BaseMenu.Root>, "children"> {
  readonly trigger: ReactElement
  readonly children: ReactNode
  readonly align?: ComponentPropsWithRef<typeof BaseMenu.Positioner>["align"]
  readonly side?: ComponentPropsWithRef<typeof BaseMenu.Positioner>["side"]
  readonly sideOffset?: number
  readonly label?: string
}

export function MenuRoot({
  trigger,
  children,
  align = "start",
  side = "bottom",
  sideOffset = px(spacing[1]),
  label,
  ...props
}: MenuRootProps): JSX.Element {
  return (
    <BaseMenu.Root {...props}>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          className="menu-positioner"
          align={align}
          side={side}
          sideOffset={sideOffset}
        >
          <BaseMenu.Popup className="menu" aria-label={label}>
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

export function MenuGroup({
  label,
  name,
  children,
}: {
  readonly label?: ReactNode
  readonly name?: string
  readonly children: ReactNode
}): JSX.Element {
  return (
    <BaseMenu.Group
      className="menu__group"
      aria-label={label === undefined ? name : undefined}
    >
      {label !== undefined && (
        <BaseMenu.GroupLabel className="menu__heading">
          {label}
        </BaseMenu.GroupLabel>
      )}
      {children}
    </BaseMenu.Group>
  )
}

interface ItemContentProps {
  readonly children: ReactNode
  readonly leading?: ReactNode
  readonly trailing?: ReactNode
}

function ItemContent({
  children,
  leading,
  trailing,
}: ItemContentProps): JSX.Element {
  return (
    <>
      <span className="menu-item__leading">{leading}</span>
      <span className="menu-item__label">{children}</span>
      {trailing !== undefined && (
        <span className="menu-item__trailing">{trailing}</span>
      )}
    </>
  )
}

export interface MenuItemProps
  extends Omit<
      ComponentPropsWithRef<typeof BaseMenu.Item>,
      "children" | "className"
    >,
    ItemContentProps {
  readonly tone?: "default" | "danger"
}

export function MenuItem({
  children,
  leading,
  trailing,
  tone = "default",
  ...props
}: MenuItemProps): JSX.Element {
  return (
    <BaseMenu.Item
      {...props}
      className={cx("menu-item", tone === "danger" && "menu-item--danger")}
    >
      <ItemContent leading={leading} trailing={trailing}>
        {children}
      </ItemContent>
    </BaseMenu.Item>
  )
}

export type MenuRadioGroupProps = ComponentPropsWithRef<
  typeof BaseMenu.RadioGroup
>

export function MenuRadioGroup(props: MenuRadioGroupProps): JSX.Element {
  return <BaseMenu.RadioGroup {...props} />
}

export interface MenuRadioItemProps
  extends Omit<
      ComponentPropsWithRef<typeof BaseMenu.RadioItem>,
      "children" | "className"
    >,
    Omit<ItemContentProps, "leading"> {}

export function MenuRadioItem({
  children,
  trailing,
  ...props
}: MenuRadioItemProps): JSX.Element {
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
