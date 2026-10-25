// The header tier readout (W-1, Q-13): the tier, the next milestone, and one progress line per
// requirement, shownStock / amount (milestones deliver from liquid, R7). Ticking numbers,
// never a live region; the tier-up toast is the announcement.
import { nextMilestoneCost } from "@manufactory/engine";
import { shownStock } from "../sync/interpolate.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import { fmt } from "./notation.js";
import { useTick } from "./use-tick.js";

export interface TierReadoutProps {
  snapshot: Snapshot;
  now: () => number;
}

export function TierReadout({ snapshot: s, now }: TierReadoutProps) {
  useTick();
  const tier = s.state.tier;
  const costs = nextMilestoneCost(s.content, s.state);
  const next = s.content.milestoneByTier.get(tier + 1);
  if (costs === null || next === undefined) {
    return (
      <div className="tier-readout" data-tier={tier}>
        {`Tier ${tier} · complete`}
      </div>
    );
  }
  const at = serverNow(s, now());
  return (
    <div className="tier-readout" data-tier={tier}>
      <div className="tier-name">{`Tier ${tier} · next: ${next.name}`}</div>
      <ul className="tier-reqs">
        {[...costs].map(([itemId, amount]) => (
          <li key={itemId} data-requirement={itemId}>
            <span>{s.content.items.get(itemId)?.name ?? itemId}</span>{" "}
            <span className="num">{`${fmt(shownStock(s, itemId, at))} / ${fmt(amount)}`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
