// The CSS source tests' shared walker (tokens.test.ts, contrast.test.ts, V-4). Pure string work:
// the tests read the files. Not imported by the app.

export interface Decl {
  file: string;
  property: string;
  value: string;
  /** Block preludes, outermost first: "@media (...)", "@keyframes x", "0%,100%", ".a .b". */
  stack: string[];
}

/** A small CSS walker: comments stripped, blocks nested, declarations with their context. */
export function declarations(file: string, text: string): Decl[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Decl[] = [];
  const stack: string[] = [];
  let buf = "";
  const flush = () => {
    const d = buf.trim();
    buf = "";
    if (!d) return;
    const colon = d.indexOf(":");
    if (colon === -1) throw new Error(`${file}: cannot parse "${d}"`);
    out.push({
      file,
      property: d.slice(0, colon).trim().toLowerCase(),
      value: d.slice(colon + 1).trim(),
      stack: [...stack],
    });
  };
  for (const ch of src) {
    if (ch === "{") {
      stack.push(buf.trim().replace(/\s+/g, " "));
      buf = "";
    } else if (ch === "}") {
      flush();
      stack.pop();
    } else if (ch === ";") {
      flush();
    } else {
      buf += ch;
    }
  }
  if (stack.length !== 0) throw new Error(`${file}: unbalanced braces`);
  return out;
}

/** The declarations of one top-level block, by its exact prelude, as a property map. */
export function block(decls: readonly Decl[], prelude: string): Record<string, string> {
  return Object.fromEntries(
    decls
      .filter((d) => d.stack.length === 1 && d.stack[0] === prelude)
      .map((d) => [d.property, d.value]),
  );
}

/** The prelude of a theme's block in tokens.css: terminal is the bare :root (U-1b). */
export function themePrelude(id: string): string {
  return id === "terminal" ? ":root" : `:root[data-theme="${id}"]`;
}

/** A theme's tokens as the cascade gives them: :root, then its own block on top. */
export function themeTokens(decls: readonly Decl[], id: string): Record<string, string> {
  const root = block(decls, ":root");
  return id === "terminal" ? root : { ...root, ...block(decls, themePrelude(id)) };
}

/** Resolves var() references (with fallbacks) against a token map. */
export function resolve(tokens: Record<string, string>, value: string, depth = 0): string {
  if (depth > 16) throw new Error(`var() cycle at ${value}`);
  const out = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, name: string, fb) => {
    const v = tokens[name] ?? (fb as string | undefined);
    if (v === undefined) throw new Error(`undefined ${name}`);
    return resolve(tokens, v.trim(), depth + 1);
  });
  return out;
}
