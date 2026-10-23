// S-13: the handbook's glossary, hand-written. §13.4 wants it readable as documentation, so
// each entry is a sentence or two in plain words, in the order a new player meets the terms.
export const GLOSSARY: readonly { term: string; text: string }[] = [
  {
    term: "Bottleneck",
    text: "The one recipe holding a lane back. Exactly one row per lane carries the frame, and its button buys what clears it. No frame means nothing in that lane is short.",
  },
  {
    term: "Mark",
    text: "A machine's generation. A higher mark runs faster and draws more power. Marks unlock with tiers, and the handbook quotes the best one you have.",
  },
  {
    term: "Ladder",
    text: "Every few machines of one kind in a lane, the whole group speeds up. Higher marks count for more rungs than lower ones.",
  },
  {
    term: "Priority",
    text: "One ordered list of what you want made. Inputs go to the top entry first, so where an item sits decides who gets the screws. You never split an intermediate by hand.",
  },
  {
    term: "Guaranteed and share",
    text: "A guaranteed entry takes all it can before the next one is served. Share entries split what is left between them, at the weights you set.",
  },
  {
    term: "Reserve",
    text: "A percentage of an item's output sent to storage even while something downstream wants it. Use it to bank for a build or a milestone.",
  },
  {
    term: "Storage tier",
    text: "An item's storage level. Each level raises its cap and costs more than the last. Storage only holds overage: what flows straight to a consumer is never capped.",
  },
  {
    term: "QS",
    text: "Quantum Storage, a second store per lane above the item's own cap. Its stock counts as yours for anything, milestones included.",
  },
  {
    term: "BOUND",
    text: "Stock above the Quantum Storage cap. It never fills up and never refills, and it can only be spent on building. A build spends it first.",
  },
  {
    term: "Power",
    text: "Generators burn fuel to feed the grid, and every machine draws from it. Short power slows every lane at once, and then the bottleneck frame moves to the dock.",
  },
  {
    term: "Tap and kick",
    text: "A tap sends power into the grid and kicks production up by a share of what you already make, for a short while. Holding the button taps a little slower.",
  },
  {
    term: "Plateau",
    text: "Away from the game, production runs for a while after your last action and then pauses. Doing anything starts it again.",
  },
];
