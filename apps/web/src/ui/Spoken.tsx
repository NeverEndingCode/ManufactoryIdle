// U-1h: a screen reader hears content names, never ids. Where the theme's visible text differs
// from its plain words (terminal's IRON_ORE, CONSTRUCTOR_MK1), the visible text is aria-hidden
// and a visually hidden copy carries the plain words; where they match, the text is just text.
export function Spoken({ shown, said }: { shown: string; said: string }) {
  if (shown === said) return <>{shown}</>;
  return (
    <>
      <span aria-hidden="true">{shown}</span>
      <span className="visually-hidden">{said}</span>
    </>
  );
}
