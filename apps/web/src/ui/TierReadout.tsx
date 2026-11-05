// The header tier readout (W-1, Q-13, V-24): the tier and each requirement of the next
// milestone, shownStock / amount (milestones deliver from liquid, R7), on one line.
//   shell: [TIER 3] next: ROTOR 214/500 · MODULAR_FRAME 38/120
//   plain: Tier 3 · next: Rotor 214/500 · Modular Frame 38/120
// The phone shows one requirement, the furthest from done: [TIER 3] ROTOR 214/500. Ticking
// numbers, never a live region; the tier-up toast is the announcement.
import { nextMilestoneCost, type Dec, type ItemId } from "@manufactory/engine";
import { Fragment } from "react";
import { shownStock } from "../sync/interpolate.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import { useNames } from "./names.js";
import { fmt } from "./notation.js";
import { useTick } from "./use-tick.js";

export interface TierReadoutProps {
  snapshot: Snapshot;
  now: () => number;
  /** The phone's one requirement (U-2d). */
  phone?: boolean;
}

interface Req {
  itemId: ItemId;
  label: string;
  progress: string;
  ratio: number;
}

export function TierReadout({ snapshot: s, now, phone = false }: TierReadoutProps) {
  useTick();
  const names = useNames(s);
  const tier = s.state.tier;
  const shell = names.voice === "shell";
  const head = shell ? `[TIER ${tier}]` : `Tier ${tier} ·`;
  const costs = nextMilestoneCost(s.content, s.state);
  if (costs === null) {
    const text = `${head} complete`;
    return (
      <div className="tier-readout" data-tier={tier} title={text}>
        {text}
      </div>
    );
  }
  const at = serverNow(s, now());
  let reqs: Req[] = [...costs].map(([itemId, amount]: [ItemId, Dec]) => {
    const shown = shownStock(s, itemId, at);
    return {
      itemId,
      label: names.item(itemId),
      progress: `${fmt(shown)}/${fmt(amount)}`,
      ratio: amount.lte(0) ? 1 : shown.div(amount).toNumber(),
    };
  });
  if (phone && reqs.length > 0) reqs = [reqs.reduce((low, r) => (r.ratio < low.ratio ? r : low))];
  const lead = phone ? `${head} ` : `${head} next: `;
  const text = lead + reqs.map((r) => `${r.label} ${r.progress}`).join(" · ");
  return (
    <div className="tier-readout" data-tier={tier} title={text}>
      {lead}
      {reqs.map((r, i) => (
        <Fragment key={r.itemId}>
          {i > 0 && " · "}
          <span data-requirement={r.itemId}>
            {`${r.label} `}
            <span className="num">{r.progress}</span>
          </span>
        </Fragment>
      ))}
    </div>
  );
}
