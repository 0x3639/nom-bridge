// Self-scheduling poll loop with failure backoff. Extracted so the two
// concurrency hazards are testable with fake timers: a run settling after
// stop() must not reschedule, and a stop()+start() while a run is in flight
// must not leave two chains ticking. Rescheduling is guarded by generation:
// only the chain that scheduled the fired timer may schedule the next one.
export interface PollScheduler {
  start: () => void
  stop: () => void
}

export function createPollScheduler(
  run: () => Promise<void>,
  nextDelay: (consecutiveFailures: number) => number,
  onSettled?: (error: Error | null) => void,
): PollScheduler {
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let consecutiveFailures = 0

  function schedule(chain: number): void {
    timer = setTimeout(() => {
      void run()
        .then(() => {
          consecutiveFailures = 0
          onSettled?.(null)
        })
        .catch((e: unknown) => {
          consecutiveFailures += 1
          onSettled?.(e instanceof Error ? e : new Error(String(e)))
        })
        .finally(() => {
          // A stop() (or stop+start) since this timer fired means this chain
          // is dead — the current chain owns rescheduling.
          if (running && chain === generation) schedule(chain)
        })
    }, nextDelay(consecutiveFailures))
  }

  return {
    start(): void {
      if (running) return
      running = true
      generation += 1
      schedule(generation)
    },
    stop(): void {
      running = false
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
