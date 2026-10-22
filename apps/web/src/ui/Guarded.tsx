// A button that stays focusable when off (the drawer's spends, the priority list's steps).
import type { ButtonHTMLAttributes } from "react";

/**
 * A button that stays focusable when it is off: aria-disabled plus a click guard, never the
 * native `disabled`, so a focused button that turns busy keeps focus and Escape still reaches
 * the drawer.
 */
export function Guarded({
  off,
  onPress,
  className = "btn",
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "disabled" | "type"> & {
  off: boolean;
  onPress(): void;
}) {
  return (
    <button
      type="button"
      className={className}
      {...rest}
      aria-disabled={off}
      onClick={() => {
        if (!off) onPress();
      }}
    />
  );
}
