import { NumberField as BaseNumberField } from "@base-ui/react/number-field"
import type { JSX } from "react"

import { Icon } from "./Icon"

export interface NumberFieldProps {
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step?: number
  readonly disabled?: boolean
  readonly label: string
  readonly decrementLabel: string
  readonly incrementLabel: string
  readonly unit?: string
  onValueChange: (value: number) => void
  onValueCommitted: (value: number) => void
}

export function NumberField({
  value,
  min,
  max,
  step = 1,
  disabled,
  label,
  decrementLabel,
  incrementLabel,
  unit,
  onValueChange,
  onValueCommitted,
}: NumberFieldProps): JSX.Element {
  return (
    <BaseNumberField.Root
      className="number-field"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={(v) => {
        if (v !== null) onValueChange(v)
      }}
      onValueCommitted={(v) => {
        if (v !== null) onValueCommitted(v)
      }}
    >
      <BaseNumberField.Group className="number-field__group">
        <BaseNumberField.Decrement
          className="btn btn--ghost btn--icon number-field__step"
          aria-label={decrementLabel}
          title={decrementLabel}
        >
          <Icon name="minus" />
        </BaseNumberField.Decrement>
        <BaseNumberField.Input
          className="input number-field__input"
          aria-label={label}
        />
        <BaseNumberField.Increment
          className="btn btn--ghost btn--icon number-field__step"
          aria-label={incrementLabel}
          title={incrementLabel}
        >
          <Icon name="plus" />
        </BaseNumberField.Increment>
      </BaseNumberField.Group>
      {unit !== undefined && <span className="number-field__unit">{unit}</span>}
    </BaseNumberField.Root>
  )
}
