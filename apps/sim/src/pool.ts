// A bounded parallel runner for the gate's worker threads, kept apart from them so its
// ordering and failure behaviour can be tested without spawning any.

/** A job once started: its eventual result, and a way to abandon it. */
export interface Started<R> {
  result: Promise<R>;
  stop(): void;
}

/**
 * Runs every job with at most `limit` in flight, and returns the results in JOB order
 * rather than completion order, so the caller sees what a serial run would have
 * produced. The first failure stops every job still in flight, starts no more, and
 * rejects with that failure: once one job has failed the run has failed, and waiting
 * on the others only delays saying so.
 */
export function runPool<J, R>(
  jobs: readonly J[],
  limit: number,
  start: (job: J) => Started<R>,
): Promise<{ results: R[]; seconds: number[] }> {
  return new Promise((resolve, reject) => {
    const results: R[] = new Array(jobs.length);
    const seconds: number[] = new Array(jobs.length);
    const inFlight = new Set<Started<R>>();
    let next = 0;
    let done = 0;
    let failed = false;

    const launch = (): void => {
      if (failed || next >= jobs.length) return;
      const index = next;
      next += 1;
      const begun = Date.now();
      const started = start(jobs[index]!);
      inFlight.add(started);
      started.result.then(
        (value) => {
          inFlight.delete(started);
          if (failed) return;
          results[index] = value;
          seconds[index] = (Date.now() - begun) / 1000;
          done += 1;
          if (done === jobs.length) resolve({ results, seconds });
          else launch();
        },
        (error: unknown) => {
          inFlight.delete(started);
          if (failed) return;
          failed = true;
          for (const other of inFlight) other.stop();
          inFlight.clear();
          reject(error);
        },
      );
    };

    if (jobs.length === 0) {
      resolve({ results, seconds });
      return;
    }
    for (let lane = 0; lane < Math.min(limit, jobs.length); lane += 1) launch();
  });
}
