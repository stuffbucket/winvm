/**
 * A number with a stepper either side: Base UI's NumberField (typing, arrow
 * keys, clamping, the increment and decrement buttons) in the window's style.
 * The same wrapper shape as Menu.tsx. Styles: `.number-field*` in styles.css.
 */
import { NumberField as BaseNumberField } from "@base-ui/react/number-field"

import { Icon } from "./Icon"

export interface NumberFieldProps {
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step?: number
  readonly disabled?: boolean
  /** Names the field for assistive tech; also the stepper buttons' context. */
  readonly label: string
  readonly decrementLabel: string
  readonly incrementLabel: string
  /** A unit after the number ("GB"), outside the input so typing stays plain digits. */
  readonly unit?: string
  onValueChange(value: number): void
  /** Blur after typing, a stepper released, an arrow key: the value to keep. */
  onValueCommitted(value: number): void
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
        <BaseNumberField.Decrement className="btn btn--ghost btn--icon number-field__step" aria-label={decrementLabel} title={decrementLabel}>
          <Icon name="minus" />
        </BaseNumberField.Decrement>
        <BaseNumberField.Input className="input number-field__input" aria-label={label} />
        <BaseNumberField.Increment className="btn btn--ghost btn--icon number-field__step" aria-label={incrementLabel} title={incrementLabel}>
          <Icon name="plus" />
        </BaseNumberField.Increment>
      </BaseNumberField.Group>
      {unit !== undefined && <span className="number-field__unit">{unit}</span>}
    </BaseNumberField.Root>
  )
}
