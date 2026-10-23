// The handbook (W-1 item 5, §13.4, S-13): the index (search, every item by lane, the
// glossary) and an item's entry (made from, alternates, traces back to, used in), over the
// pure model in handbook.ts. The route says which: /handbook or /handbook/:item. An unknown
// item shows the index. Below 600 px it is the third view; wider, it takes the detail pane.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { D, POWER_ITEM, type ItemId, type NotationMode } from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import { GLOSSARY } from "./glossary.js";
import { handbookEntry, searchItems, type HandbookEntry, type RecipeLine } from "./handbook.js";
import styles from "./Handbook.module.css";
import { fmt, useNotation } from "./notation.js";

export interface HandbookProps {
  snapshot: Snapshot;
  itemId: ItemId | null;
  onOpen(itemId: ItemId | null): void;
}

/** Entries, memoised per snapshot, item and notation. */
const entries = new WeakMap<Snapshot, Map<string, HandbookEntry | null>>();
function entryOf(s: Snapshot, itemId: ItemId, notation: NotationMode): HandbookEntry | null {
  let byKey = entries.get(s);
  if (byKey === undefined) entries.set(s, (byKey = new Map()));
  const key = `${notation}:${itemId}`;
  if (!byKey.has(key)) byKey.set(key, handbookEntry(s.content, s.display.state, itemId, notation));
  return byKey.get(key)!;
}

/** "A, B and C". */
function listText(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function Handbook({ snapshot, itemId, onOpen }: HandbookProps) {
  const [notation] = useNotation();
  const entry = itemId === null ? null : entryOf(snapshot, itemId, notation);
  const root = useRef<HTMLElement>(null);

  // Focus is never lost (W-20): whatever the player clicked (a list item, a chip, Back) is gone
  // after the switch, so the new entry's title, or the search, takes focus. Focus anywhere
  // else (the header button, a tab) is left where it is.
  const shownKey = entry === null ? "index" : entry.itemId;
  useEffect(() => {
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    root.current?.querySelector<HTMLElement>(entry === null ? "input[type=search]" : "h2")?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on a switch of view
  }, [shownKey]);

  return (
    <section
      ref={root}
      className={styles.handbook}
      aria-label="Handbook"
      data-handbook={entry === null ? "index" : entry.itemId}
    >
      {entry === null ? (
        <Index snapshot={snapshot} onOpen={onOpen} />
      ) : (
        <Entry snapshot={snapshot} entry={entry} onOpen={onOpen} />
      )}
    </section>
  );
}

function Index({ snapshot, onOpen }: Pick<HandbookProps, "snapshot" | "onOpen">) {
  const [query, setQuery] = useState("");
  const { content } = snapshot;
  const state = snapshot.display.state;
  const rows = useMemo(() => searchItems(content, state, query), [content, state, query]);
  const lanes: { name: string; rows: typeof rows }[] = [];
  for (const r of rows) {
    const last = lanes[lanes.length - 1];
    if (last !== undefined && last.name === r.laneName) last.rows.push(r);
    else lanes.push({ name: r.laneName, rows: [r] });
  }
  const id = useId();
  return (
    <>
      <h2 className={styles.title}>Handbook</h2>
      <input
        type="search"
        className={styles.search}
        aria-label="Search the handbook"
        placeholder="Search items"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-handbook-search
      />
      {rows.length === 0 && <p className={styles.muted}>{`No item matches “${query.trim()}”.`}</p>}
      {lanes.map((lane, i) => (
        <section key={lane.name} aria-labelledby={`${id}-lane-${i}`} className={styles.lane}>
          <h3 id={`${id}-lane-${i}`} className={styles.laneName}>
            {lane.name}
          </h3>
          <ul className={styles.items}>
            {lane.rows.map((r) => (
              <li key={r.itemId}>
                <button
                  type="button"
                  className={r.locked ? `${styles.item} ${styles.locked}` : styles.item}
                  data-handbook-item={r.itemId}
                  data-locked={r.locked ? "" : undefined}
                  onClick={() => onOpen(r.itemId)}
                >
                  <span className={styles.name}>{r.name}</span>
                  {r.locked && (
                    <span className={`${styles.tag} num`}>
                      {`tier ${content.items.get(r.itemId)!.tier}`}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <section aria-labelledby={`${id}-glossary`} className={styles.glossary}>
        <h3 id={`${id}-glossary`} className={styles.laneName}>
          Glossary
        </h3>
        <dl data-glossary>
          {GLOSSARY.map((g) => (
            <div key={g.term} className={styles.term}>
              <dt>{g.term}</dt>
              <dd>{g.text}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}

function Parts({ parts }: { parts: { itemId: ItemId; name: string; perMin: string }[] }) {
  return (
    <>
      {parts.map((p) => (
        <span key={p.itemId} className={styles.part}>
          <span className={styles.name}>{p.name}</span>
          <span className="num">{`${p.perMin}/min`}</span>
        </span>
      ))}
    </>
  );
}

function Line({ line }: { line: RecipeLine }) {
  return (
    <div
      className={line.locked ? `${styles.line} ${styles.locked}` : styles.line}
      data-recipe={line.recipeId}
      data-locked={line.locked ? "" : undefined}
    >
      <p className={styles.lineHead}>
        <span className={styles.name}>{line.name}</span>
        <span className={styles.muted}>{line.machine}</span>
        {line.locked && (
          <span className={`${styles.tag} num`}>{`unlocks at tier ${line.unlockTier}`}</span>
        )}
      </p>
      <p className={styles.io}>
        {line.inputs.length === 0 ? (
          <span className={styles.muted}>Extracted</span>
        ) : (
          <Parts parts={line.inputs} />
        )}
        <span aria-hidden="true" className={styles.arrow}>
          →
        </span>
        <span className={styles.srOnly}>makes</span>
        {line.outputs.length === 0 ? (
          <span className={styles.muted}>Power</span>
        ) : (
          <Parts
            parts={line.outputs.map((o) => ({
              ...o,
              name: o.byproduct ? `${o.name} (byproduct)` : o.name,
            }))}
          />
        )}
      </p>
      {line.power !== null && (
        <p className={styles.muted}>
          {line.power.kind === "draw" ? (
            <>
              {`${line.power.mark} draws `}
              <span className="num">{`${fmt(D(line.power.mw))} MW`}</span>
            </>
          ) : (
            <>
              {"Generates "}
              <span className="num">{`${fmt(D(line.power.mw))} MW`}</span>
            </>
          )}
        </p>
      )}
    </div>
  );
}

function Entry({
  snapshot,
  entry: e,
  onOpen,
}: Pick<HandbookProps, "snapshot" | "onOpen"> & { entry: HandbookEntry }) {
  const id = useId();
  const h = (k: string) => `${id}-${k}`;
  const extracted = e.madeFrom !== null && e.madeFrom.inputs.length === 0;
  return (
    <article aria-labelledby={h("title")} data-handbook-entry={e.itemId} className={styles.entry}>
      <h2 id={h("title")} tabIndex={-1} className={styles.title}>
        {e.name}
      </h2>
      <p className={styles.identity} data-identity>
        <span>{`${e.laneName} lane`}</span>
        <span className="num">{`tier ${e.tier}`}</span>
        <span>
          {"cap "}
          <span className="num">{e.capText}</span>
        </span>
        {e.locked && <span className={styles.tag}>{`unlocks at tier ${e.tier}`}</span>}
      </p>

      <section aria-labelledby={h("made")}>
        <h3 id={h("made")} className={styles.heading}>
          Made from
        </h3>
        {e.madeFrom !== null ? (
          <Line line={e.madeFrom} />
        ) : e.byproductOf.length > 0 ? (
          <p data-byproduct-of>
            {`A byproduct of ${listText(e.byproductOf.map((b) => b.name))}. No recipe makes it on purpose.`}
          </p>
        ) : (
          <p className={styles.muted}>No recipe makes it.</p>
        )}
      </section>

      {e.alternates.length > 0 && (
        <section aria-labelledby={h("alt")}>
          <h3 id={h("alt")} className={styles.heading}>
            Alternates
          </h3>
          {e.alternates.map((a) => (
            <Line key={a.recipeId} line={a} />
          ))}
        </section>
      )}

      <section aria-labelledby={h("trace")} data-traces>
        <h3 id={h("trace")} className={styles.heading}>
          Traces back to
        </h3>
        {e.tracedAt !== null && (
          <p className={styles.muted} data-traced-at>
            {`At tier ${e.tracedAt.tier}, default recipes.`}
          </p>
        )}
        {extracted ? (
          <p>A raw resource: it is extracted, not made.</p>
        ) : e.tracesBack.length === 0 ? (
          <p className={styles.muted}>
            {e.byproductOf.length > 0
              ? "Nothing to trace: its cost is charged to what it comes with."
              : "Nothing to trace yet."}
          </p>
        ) : (
          <>
            <p className={styles.chain} data-chain>
              {e.chain.join(" → ")}
            </p>
            <ul className={styles.amounts}>
              {e.tracesBack.map((t) => (
                <li key={t.itemId} className={styles.part}>
                  <span className="num">{t.amountText}</span>
                  <span className={styles.name}>{`${t.name} per ${e.name}`}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby={h("used")}>
        <h3 id={h("used")} className={styles.heading}>
          Used in
        </h3>
        {e.usedIn.length === 0 ? (
          <p className={styles.muted}>Not used in any recipe yet.</p>
        ) : (
          <ul className={styles.chips} aria-labelledby={h("used")}>
            {e.usedIn.map((u) => {
              const tier = snapshot.content.recipes.get(u.recipeId)!.def.unlockTier;
              const label = u.locked ? `${u.name}, tier ${tier}` : u.name;
              return (
                <li key={u.recipeId}>
                  {u.outputItemId === POWER_ITEM ? (
                    // A generator: power has no entry of its own.
                    <span className={`${styles.chip} ${styles.static}`} data-used-in={u.recipeId}>
                      {`${label} (power)`}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={u.locked ? `${styles.chip} ${styles.locked}` : styles.chip}
                      data-used-in={u.recipeId}
                      data-locked={u.locked ? "" : undefined}
                      onClick={() => onOpen(u.outputItemId)}
                    >
                      {label}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <button
        type="button"
        className={`btn secondary ${styles.back}`}
        data-handbook-back
        onClick={() => onOpen(null)}
      >
        Back to the handbook
      </button>
    </article>
  );
}
