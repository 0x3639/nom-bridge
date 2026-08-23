import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createPollScheduler} from './poll-scheduler'

function deferred(): {promise: Promise<void>; resolve: () => void; reject: (e: Error) => void} {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {promise, resolve, reject}
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createPollScheduler', () => {
  it('runs at the base delay while healthy and backs off per consecutive failure', async () => {
    const runs: Array<ReturnType<typeof deferred>> = []
    const run = vi.fn(() => {
      const d = deferred()
      runs.push(d)
      return d.promise
    })
    const scheduler = createPollScheduler(run, failures => (failures === 0 ? 100 : 200))
    scheduler.start()

    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(1)
    runs[0].reject(new Error('offline'))
    await vi.advanceTimersByTimeAsync(0)

    // Failure → backoff delay used for the next tick.
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(2)
    runs[1].resolve()
    await vi.advanceTimersByTimeAsync(0)

    // Success → back to base delay.
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(3)
    scheduler.stop()
  })

  it('reports outcomes to the onSettled callback', async () => {
    const settled = vi.fn()
    const failure = new Error('boom')
    let n = 0
    const scheduler = createPollScheduler(
      () => (n++ === 0 ? Promise.reject(failure) : Promise.resolve()),
      () => 50,
      settled,
    )
    scheduler.start()
    await vi.advanceTimersByTimeAsync(50)
    expect(settled).toHaveBeenLastCalledWith(failure)
    await vi.advanceTimersByTimeAsync(50)
    expect(settled).toHaveBeenLastCalledWith(null)
    scheduler.stop()
  })

  it('does not double-chain when stopped during an in-flight run and restarted', async () => {
    const runs: Array<ReturnType<typeof deferred>> = []
    const run = vi.fn(() => {
      const d = deferred()
      runs.push(d)
      return d.promise
    })
    const scheduler = createPollScheduler(run, () => 100)
    scheduler.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(1)

    // Stop while run #1 is in flight, then start a new chain.
    scheduler.stop()
    scheduler.start()
    runs[0].resolve() // the old chain's run settles AFTER the restart
    await vi.advanceTimersByTimeAsync(0)

    // Only the new chain's timer may fire: one run per interval, not two.
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(2)
    runs[1].resolve()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(3)
    scheduler.stop()
  })

  it('start() while already running is a no-op', async () => {
    const run = vi.fn(() => Promise.resolve())
    const scheduler = createPollScheduler(run, () => 100)
    scheduler.start()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })
})
