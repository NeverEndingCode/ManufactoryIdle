// A button that stays focusable when off (the drawer's spends, the priority list's steps, the
// account forms' submits).
import type { ButtonHTMLAttributes } from "react";

type Base = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "disabled" | "type"> & {
  off: boolean;
};

/**
 * A button that stays focusable when it is off: aria-disabled plus a click guard, never the
 * native `disabled`, so a focused button that turns busy keeps focus and Escape still reaches
 * the drawer. With `submit`, it is its form's submit button: the form's onSubmit does the
 * work, and an off button cancels the click, which cancels the submission too (Enter in a
 * field included, since implicit submission clicks the default button).
 */
export function Guarded(props: Base & ({ submit?: false; onPress(): void } | { submit: true })) {
  const { off, className = "btn", ...rest } = props;
  const submit = "submit" in rest && rest.submit === true;
  const onPress = "onPress" in rest ? rest.onPress : undefined;
  const attrs: Record<string, unknown> = { ...rest };
  delete attrs.submit;
  delete attrs.onPress;
  return (
    <button
      type={submit ? "submit" : "button"}
      className={className}
      {...attrs}
      aria-disabled={off}
      onClick={(e) => {
        if (off) e.preventDefault();
        else onPress?.();
      }}
    />
  );
}
