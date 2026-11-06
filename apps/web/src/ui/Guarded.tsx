// A button that stays focusable when off (the drawer's spends, the priority list's steps, the
// account buttons).
import type { ButtonHTMLAttributes } from "react";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "disabled" | "type"> & {
  off: boolean;
  onPress(): void;
};

/**
 * A button that stays focusable when it is off: aria-disabled plus a click guard, never the
 * native `disabled`, so a focused button that turns busy keeps focus and Escape still reaches
 * the drawer.
 */
export function Guarded({ off, onPress, className = "btn", ...rest }: Props) {
  return (
    <button
      type="button"
      className={className}
      {...rest}
      aria-disabled={off}
      onClick={(e) => {
        if (off) e.preventDefault();
        else onPress();
      }}
    />
  );
}
