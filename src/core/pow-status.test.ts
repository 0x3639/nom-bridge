import {describe, expect, it} from 'vitest'
import {isGeneratingPow, trackPow} from './pow-status'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {promise, resolve, reject}
}

describe('trackPow', () => {
  it('tracks a successful generation and forwards arguments and results', async () => {
    const pending = deferred<string>()
    const tracked = trackPow(async (prefix: string, id: number) => {
      expect(prefix).toBe('pow')
      expect(id).toBe(7)
      return pending.promise
    })

    const result = tracked('pow', 7)
    expect(isGeneratingPow.value).toBe(true)
    pending.resolve('done')

    await expect(result).resolves.toBe('done')
    expect(isGeneratingPow.value).toBe(false)
  })

  it('stays active until every overlapping generation settles', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    const tracked = trackPow((pending: Promise<void>) => pending)

    const firstResult = tracked(first.promise)
    const secondResult = tracked(second.promise)
    expect(isGeneratingPow.value).toBe(true)

    first.resolve()
    await firstResult
    expect(isGeneratingPow.value).toBe(true)

    second.resolve()
    await secondResult
    expect(isGeneratingPow.value).toBe(false)
  })

  it('clears the status when generation rejects', async () => {
    const pending = deferred<never>()
    const tracked = trackPow(() => pending.promise)

    const result = tracked()
    pending.reject(new Error('generation failed'))

    await expect(result).rejects.toThrow('generation failed')
    expect(isGeneratingPow.value).toBe(false)
  })
})
