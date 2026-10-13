import { describe, expect, it } from "vitest";
import { runPool, type Started } from "./pool.js";

/** A job that settles when told to, and records whether it was stopped. */
function controllable() {
  let settle!: (outcome: { value?: number; error?: Error }) => void;
  const result = new Promise<number>((resolve, reject) => {
    settle = ({ value, error }) => (error ? reject(error) : resolve(value!));
  });
  const job = { stopped: false, started: false, settle };
  const start = (): Started<number> => {
    job.started = true;
    return { result, stop: () => (job.stopped = true) };
  };
  return { job, start };
}

describe("runPool", () => {
  it("returns results in job order, not completion order", async () => {
    const a = controllable();
    const b = controllable();
    const starts = [a.start, b.start];
    const pending = runPool([0, 1], 2, (i) => starts[i]!());
    b.job.settle({ value: 20 });
    a.job.settle({ value: 10 });
    expect((await pending).results).toEqual([10, 20]);
  });

  // The gate runs each policy in a worker thread for minutes. When one fails, the gate
  // has already failed: the others must be stopped and nothing new started, or the
  // process sits waiting on them before it can report.
  it("stops the jobs in flight and starts no more once one fails", async () => {
    const failing = controllable();
    const running = controllable();
    const queued = controllable();
    const starts = [failing.start, running.start, queued.start];
    const pending = runPool([0, 1, 2], 2, (i) => starts[i]!());

    failing.job.settle({ error: new Error("worker died") });
    await expect(pending).rejects.toThrow("worker died");
    expect(running.job.stopped).toBe(true);
    expect(queued.job.started).toBe(false);
  });
});
