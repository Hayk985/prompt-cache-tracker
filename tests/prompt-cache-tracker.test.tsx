import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'
import { colorAt, renewAt, tierFromTranscript } from '../hooks/register'

const MINUTE = 60_000
const SECOND = 1000
// The log file of session s1, as the stand-in lookup names it.
const PATH = '/p/s1.jsonl'

const ABOVE_PROMPT = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const EMERALD = '#36d399'
const LEAF = '#44d926'
const YELLOW = '#facc14'
const RED = '#ef4343'
const GREY = '#6b6a64'
const TRACK = '#3a3a37'

type Ttl = '5m' | '1h'

function row(tier: Ttl, extra: Record<string, unknown> = {}, model = 'm') {
  return JSON.stringify({
    type: 'assistant',
    ...extra,
    message: {
      model,
      usage: {
        cache_creation: {
          ephemeral_1h_input_tokens: tier === '1h' ? 40_000 : 0,
          ephemeral_5m_input_tokens: tier === '5m' ? 40_000 : 0,
        },
      },
    },
  })
}

// Everything beneath the mod, set as the test goes: the engine's answers,
// the usage of each request, the transcript on disk and the pings sent.
type World = {
  usage: { read: number; write: number; input: number; output: number; model: string }
  transcript: string | null
  isLarge: boolean
  tailArgs: string[][]
  // The session id, and each id the mod looked a log file up for.
  sessionId: string
  lookups: string[]
  // Whether the lookup finds the session's log file, and each file read.
  isLogFound: boolean
  reads: string[]
  pings: string[]
  // When each ping went in, by the test's clock.
  pingAt: number[]
  dropPings: number
  pingReplies: boolean
  // How long a ping waits before its turn, and a request before its reply.
  pingDelay: number
  stepDelay: number
  compactSkip: boolean
}

function world($: Engine, on: On, transcript: string | null, clock?: MockClock, stored?: Record<string, unknown>): World {
  const w: World = {
    usage: { read: 0, write: 50_000, input: 10, output: 5, model: 'm' },
    transcript,
    isLarge: false,
    tailArgs: [],
    sessionId: 's1',
    lookups: [],
    isLogFound: true,
    reads: [],
    pings: [],
    pingAt: [],
    dropPings: 0,
    pingReplies: false,
    pingDelay: 0,
    stepDelay: 0,
    compactSkip: false,
  }
  mock.store(on, stored)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.compact', (_$, e) => (w.compactSkip ? { skip: 'nothing to compact' } : { messages: e.messages }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.id', () => ({ value: w.sessionId }))
  on('turn.step', async function* (_$, e) {
    if (w.stepDelay > 0 && clock) await clock.sleep(w.stepDelay)
    const u = w.usage
    return {
      turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn',
      usage: { model: u.model, input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.write },
    }
  })
  on('fs.read', (_$, e) => {
    w.reads.push(e.path)
    if (w.transcript === null) return { deny: 'missing' }
    if (w.isLarge) return { deny: 'over 4 MiB' }
    return { value: w.transcript }
  })
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'sh' && e.argv[2]!.includes('/projects/')) {
      // The log file lookup: each session id has a file of its own.
      const id = e.argv.at(-1)!
      w.lookups.push(id)
      const stdout = w.isLogFound ? `/p/${id}.jsonl\n` : ''
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    w.tailArgs.push([...e.argv])
    const isRead = w.transcript !== null
    return {
      value: {
        exitCode: isRead ? 0 : 1,
        stdout: w.transcript ?? '',
        stderr: isRead ? '' : 'no such file',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('prompt.submit', (_$, e) => {
    if (e.text === 'boom') throw new Error('a hook beneath failed')
    if (e.text !== 'Warming up (just reply ok)') return { text: e.text }
    w.pings.push(e.text)
    if (clock) w.pingAt.push(clock.now())
    if (w.dropPings > 0) {
      w.dropPings -= 1
      return { drop: 'busy' }
    }
    // The ping's own turn refreshes the cache, as a real one would.
    if (w.pingReplies && w.pingDelay > 0 && clock) void clock.sleep(w.pingDelay).then(() => turn($))
    else if (w.pingReplies) void turn($)
    return { text: e.text }
  })
  return w
}

async function start($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  await $.session.start({ cwd: '/', surface, isInteractive: true })
}

async function step($: Engine, agentId?: string) {
  const input = { turnId: 't', index: 0, model: 'm', messageCount: 2, ...(agentId ? { agentId } : {}) }
  for await (const _ of $.turn.step(input as any)) {
    // drain
  }
}

// A turn's start and its request.
async function beginTurn($: Engine) {
  await $.turn.start({ text: 'x', turnId: 't' } as any)
  await step($)
}

// A turn's end.
async function endTurn($: Engine) {
  await $.turn.complete({ turnId: 't', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false } as any)
}

// One whole turn: start, a request and the end.
async function turn($: Engine) {
  await beginTurn($)
  await endTurn($)
}

function cacheTtl($: Engine, arg: string) {
  return $.command.run({ command: 'cache-ttl', args: arg, origin: { kind: 'composer' } } as any)
}

function clear($: Engine) {
  return $.session.end({ reason: 'clear', sessionId: 's' } as any)
}

function compact($: Engine, trigger: 'manual' | 'auto' | 'precompute', agentId?: string) {
  const messages = [{ role: 'user', text: 'summary', toolUses: [] }]
  return $.session.compact({ trigger, ...(agentId ? { agentId } : {}), messages } as any)
}

function person($: Engine, text = 'hello') {
  return $.prompt.submit({ text, origin: { kind: 'composer' } } as any)
}

// The bar, mounted where the engine draws it.
function mount($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({ plugin: 'prompt-cache-tracker', surface, ...ABOVE_PROMPT })
}

// What a mounted bar shows.
async function read<P extends 'terminal' | 'desktop'>(ui: Mounted<P, 'AbovePrompt'>) {
  const label = await ui.find({ type: 'Text', text: /left|expired/ })
  const bars = await ui.findAll({ type: 'Text', text: /━/ })
  const filled = bars.find(bar => bar.props.color !== TRACK)?.text.length ?? 0
  const button = await ui.find({ key: 'keep-warm' })
  return { label: label?.text.trim(), color: label?.props.color, filled, button: button?.text }
}

// What the bar shows right now: a fresh mount draws the current moment.
async function look($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await mount($, surface)
  const shown = await read(ui)
  await ui.unmount()
  return shown
}

// When the mod asked for a redraw: each tick does.
function redraws(on: On, clock: MockClock): number[] {
  const at: number[] = []
  on('ui.invalidate', (_$, e, next) => {
    if (e.event === 'ui.render') at.push(clock.now())
    return next(e)
  })
  return at
}

// Needs engineStandIn registered first: a hidden bar leaves the engine's own drawing.
async function isHidden($: Engine) {
  const ui = await mount($)
  const found = await ui.find({ type: 'Text', text: /engine stand-in/ })
  await ui.unmount()
  return found !== undefined
}

function engineStandIn(on: On) {
  on('ui.render', (_$, e) => {
    const { Text } = _$.ui.resolve(e)
    return <Text>engine stand-in</Text>
  })
}

async function pressKeepWarm($: Engine) {
  const ui = await mount($)
  await ui.press({ key: 'keep-warm' })
  await ui.unmount()
}

// Colors

test('the color stops are Emerald, Leaf, yellow and red', () => {
  expect(colorAt(1)).toBe(EMERALD)
  expect(colorAt(0.75)).toBe(LEAF)
  expect(colorAt(0.5)).toBe(YELLOW)
  expect(colorAt(0)).toBe(RED)
})

test('the colors in between blend smoothly', () => {
  // Each 1% step moves no channel far: no jump at a stop.
  const channels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  for (let p = 100; p > 0; p--) {
    const a = channels(colorAt(p / 100))
    const b = channels(colorAt((p - 1) / 100))
    for (let i = 0; i < 3; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(16)
  }
})

// The bar on each tier

test('on a 1-hour cache the bar drains over the hour', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  world($, on, row('1h'))
  await start($)
  await turn($)

  // [minutes since the request, label, color, filled cells of 24]
  const marks: [number, string, string, number][] = [
    [0, '60m left', EMERALD, 24],
    [15, '45m left', LEAF, 18],
    [30, '30m left', YELLOW, 12],
    [50, '10m left', colorAt(10 / 60), 4],
    [54, '6m left', colorAt(6 / 60), 2],
    [59.5, '1m left', colorAt(0.5 / 60), 1],
    [60, 'expired', GREY, 0],
  ]
  let at = 0
  for (const [minute, label, color, filled] of marks) {
    await clock.advance((minute - at) * MINUTE)
    at = minute
    const terminal = await look($)
    expect({ label: terminal.label, color: terminal.color, filled: terminal.filled }).toEqual({ label, color, filled })
    const desktop = await look($, 'desktop')
    expect(desktop.label).toBe(label)
    expect(desktop.color).toBe(color)
  }
})

test('on a 5-minute cache the bar drains over five minutes', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  world($, on, row('5m'))
  await start($)
  await turn($)

  // [seconds since the request, label, color, filled cells of 24]
  const marks: [number, string, string, number][] = [
    [0, '5m left', EMERALD, 24],
    [75, '4m left', LEAF, 18],
    [150, '3m left', YELLOW, 12],
    [240, '1m left', colorAt(0.2), 5],
    [270, '1m left', colorAt(0.1), 2],
    [300, 'expired', GREY, 0],
  ]
  let at = 0
  for (const [second, label, color, filled] of marks) {
    await clock.advance((second - at) * SECOND)
    at = second
    const terminal = await look($)
    expect({ label: terminal.label, color: terminal.color, filled: terminal.filled }).toEqual({ label, color, filled })
    const desktop = await look($, 'desktop')
    expect(desktop.label).toBe(label)
    expect(desktop.color).toBe(color)
  }
})

test('a pinned tier still waits for a reply before showing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  engineStandIn(on)
  await start($)
  await cacheTtl($, '5m')
  expect(await isHidden($)).toBe(true)
  await clock.advance(2 * 60 * MINUTE)
  expect(await isHidden($)).toBe(true)
  expect(w.pings.length).toBe(0)

  await turn($)
  expect((await look($)).label).toBe('5m left')
})

test('with no reply the bar never shows and nothing is sent', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  engineStandIn(on)
  await start($)
  expect(await isHidden($)).toBe(true)
  await clock.advance(3 * 60 * MINUTE)
  expect(await isHidden($)).toBe(true)
  expect(w.pings.length).toBe(0)
})

test('an unreadable transcript never shows the bar across replies', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, null)
  engineStandIn(on)
  await start($)
  await turn($)
  expect(await isHidden($)).toBe(true)
  await clock.advance(10 * MINUTE)
  await turn($)
  expect(await isHidden($)).toBe(true)
  await clock.advance(2 * 60 * MINUTE)
  expect(await isHidden($)).toBe(true)
  expect(w.pings.length).toBe(0)
})

// Telling the tiers apart

test('the bar waits for the transcript before showing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, '')
  engineStandIn(on)
  await start($)
  // The request's row isn't in the log yet: no tier to count.
  await beginTurn($)
  expect(await isHidden($)).toBe(true)
  await clock.advance(70 * MINUTE)
  expect(w.pings.length).toBe(0)

  // At the turn's end the row is there.
  w.transcript = row('1h')
  await endTurn($)
  expect((await look($)).label).toBe('expired')
})

test('the log is found by the session id, and /clear moves to the new one', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  await start($)
  await turn($)
  expect((await look($)).label).toBe('60m left')
  expect(w.reads.at(-1)).toBe('/p/s1.jsonl')
  // Found once, then kept: later turns look nothing up.
  const looked = w.lookups.length
  await turn($)
  expect(w.lookups.length).toBe(looked)

  await clear($)
  w.sessionId = 's2'
  w.transcript = row('5m')
  await turn($)
  expect(w.lookups.at(-1)).toBe('s2')
  expect(w.reads.at(-1)).toBe('/p/s2.jsonl')
  expect((await look($)).label).toBe('5m left')
})

test('a log file not written yet is looked up again on the next turn', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  engineStandIn(on)
  w.isLogFound = false
  await start($)
  await turn($)
  expect(await isHidden($)).toBe(true)

  w.isLogFound = true
  await turn($)
  expect((await look($)).label).toBe('60m left')
})

test('a transcript that becomes readable later still sets the tier', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world($, on, null)
  engineStandIn(on)
  await start($)
  await turn($)
  expect(await isHidden($)).toBe(true)

  w.transcript = row('5m')
  await turn($)
  expect((await look($)).label).toBe('5m left')
})

test('/cache-ttl sets the tier, and auto with no readable transcript hides the bar', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world($, on, null)
  engineStandIn(on)
  await start($)
  await turn($)
  await cacheTtl($, '1h')
  expect((await look($)).label).toBe('60m left')
  await cacheTtl($, 'auto')
  expect(await isHidden($)).toBe(true)
})

test('/cache-ttl 5m then auto returns to the transcript tier', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world($, on, row('1h'))
  await start($)
  await turn($)
  await cacheTtl($, '5m')
  expect((await look($)).label).toBe('5m left')
  await cacheTtl($, 'auto')
  expect((await look($)).label).toBe('60m left')
})

test('/cache-ttl replies say which cache is tracked, and wait for a reply when none is known', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world($, on, row('1h'))
  await start($)
  expect(await cacheTtl($, '')).toEqual({
    text: 'Waiting for your first reply to detect the cache.',
  })
  await turn($)
  expect(await cacheTtl($, '')).toEqual({
    text: 'Tracking the 1-hour cache. Change it with /cache-ttl 5m, 1h or auto.',
  })
  expect(await cacheTtl($, '5m')).toEqual({ text: 'Tracking the 5-minute cache.' })
  expect(await cacheTtl($, 'auto')).toEqual({ text: 'Detecting the cache automatically.' })
})

test('a /cache-ttl pin is restored from the store when a session starts', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  // An earlier run's /cache-ttl 5m, kept in the store; this module starts on auto.
  world($, on, row('1h'), undefined, { ttlMode: '5m' })
  await start($)
  await turn($)
  expect((await look($)).label).toBe('5m left')
})

test('any 5-minute write means 5 minutes; other rows are skipped', () => {
  const both = (hour: number, five: number) =>
    JSON.stringify({
      type: 'assistant',
      message: { model: 'm', usage: { cache_creation: { ephemeral_1h_input_tokens: hour, ephemeral_5m_input_tokens: five } } },
    })
  // 1-hour entries come first in a request, so a 5-minute write is its end.
  expect(tierFromTranscript(both(40_000, 300))).toBe('5m')
  expect(tierFromTranscript(both(40_000, 0))).toBe('1h')
  expect(tierFromTranscript([row('1h'), row('5m', {}, '<synthetic>')].join('\n'))).toBe('1h')
  expect(tierFromTranscript([row('5m'), row('1h', { isSidechain: true })].join('\n'))).toBe('5m')
  expect(tierFromTranscript('not json\n{"type":"user"}')).toBe(null)
})

test('a large transcript is read from its tail', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world($, on, ['ial line"}', row('5m'), row('1h', { isSidechain: true }), '{"type":"user"}'].join('\n'))
  w.isLarge = true
  await start($)
  await turn($)
  expect(w.tailArgs.at(-1)).toEqual(['tail', '-c', '2000000', PATH])
  expect((await look($)).label).toBe('5m left')
})

test('a small request still refreshes the countdown', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  await start($)
  await turn($)
  await clock.advance(30 * MINUTE)
  w.usage.read = 300
  w.usage.write = 20
  await turn($)
  expect((await look($)).label).toBe('60m left')
})

test('a subagent step does not move the countdown', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  await start($)
  await turn($)
  await clock.advance(50 * MINUTE)
  await step($, 'a')
  expect((await look($)).label).toBe('10m left')
  await clock.advance(4 * MINUTE - 1)
  expect(w.pings.length).toBe(0)
  await clock.advance(1)
  expect(w.pings.length).toBe(1)
})

// When the ping goes out

test('the renew point is 10% left', () => {
  expect(renewAt('1h')).toBe(6 * MINUTE)
  expect(renewAt('5m')).toBe(30 * SECOND)
})

test('on a 1-hour cache the ping goes out at 6 minutes left, once', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  await start($)
  await turn($)
  await clock.advance(54 * MINUTE - 1)
  expect(w.pings.length).toBe(0)
  await clock.advance(1)
  expect(w.pings.length).toBe(1)
  expect(w.pings[0]).toBe('Warming up (just reply ok)')
  await clock.advance(6 * MINUTE)
  expect(w.pings.length).toBe(1)
})

test('on a 5-minute cache the ping goes out at 30 seconds left', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('5m'))
  await start($)
  await turn($)
  await clock.advance(270 * SECOND - 1)
  expect(w.pings.length).toBe(0)
  await clock.advance(1)
  expect(w.pings.length).toBe(1)
})

test('time between Enter and the request does not move the ping', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('5m'))
  await start($)
  // The person's request goes out 30 seconds after Enter.
  await person($)
  await clock.advance(30 * SECOND)
  await turn($)
  await clock.advance(270 * SECOND - 1)
  expect(w.pings.length).toBe(0)
  await clock.advance(1)
  expect(w.pings.length).toBe(1)
})

test('keep warm off lets it expire', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  await start($)
  await turn($)
  await pressKeepWarm($)
  expect((await look($)).button).toMatch(/\[ \]/)
  await clock.advance(61 * MINUTE)
  expect(w.pings.length).toBe(0)
  expect((await look($)).label).toBe('expired')
})

test('on a 1-hour cache a dropped ping is tried again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  w.dropPings = 1
  await start($)
  await turn($)
  await clock.advance(54 * MINUTE)
  expect(w.pings.length).toBe(1)
  await clock.advance(45 * SECOND)
  expect(w.pings.length).toBe(2)
  expect(w.dropPings).toBe(0)
})

// Checks follow the cache refresh

test('on a 5-minute cache a reply between ticks moves the ping to 30 seconds before its expiry', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('5m'), clock)
  await start($)
  await turn($)
  await clock.advance(13 * SECOND)
  const A = clock.now()
  await turn($)
  await clock.advance(270 * SECOND - 1)
  expect(w.pings.length).toBe(0)
  await clock.advance(1)
  expect(w.pingAt).toEqual([A + 270 * SECOND])
})

test('on a 1-hour cache a reply between ticks moves the ping to 6 minutes before its expiry', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'), clock)
  await start($)
  await turn($)
  await clock.advance(48 * SECOND)
  const A = clock.now()
  await turn($)
  await clock.advance(54 * MINUTE - 1)
  expect(w.pings.length).toBe(0)
  await clock.advance(1)
  expect(w.pingAt).toEqual([A + 54 * MINUTE])
})

for (const [tier, tick] of [['5m', 10 * SECOND], ['1h', 45 * SECOND]] as const) {
  test(`on a ${tier} cache the redraws restart from each reply, and the old ones stop`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world($, on, row(tier), clock)
    const at = redraws(on, clock)
    await start($)
    await turn($)
    await clock.advance(13 * SECOND)
    expect(at.length).toBeGreaterThan(0)
    const B = clock.now()
    await turn($)
    at.length = 0
    await clock.advance(6 * tick)
    expect(at).toEqual([1, 2, 3, 4, 5, 6].map(k => B + k * tick))
  })
}

// A ping's turn starts this long after it went in: its reply refreshes the
// cache then, and the next ping counts from there.
for (const [delay, second] of [[15, 555], [3, 543]] as const) {
  test(`a ping whose request starts ${delay}s late restarts the countdown from that request start`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = world($, on, row('5m'), clock)
    w.pingReplies = true
    w.pingDelay = delay * SECOND
    await start($)
    const A = clock.now()
    await turn($)
    await clock.advance(10 * MINUTE)
    expect(w.pingAt.slice(0, 2)).toEqual([A + 270 * SECOND, A + second * SECOND])
  })
}

test('the bar redraws the moment a reply lands', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  world($, on, row('5m'), clock)
  engineStandIn(on)
  await start($)
  // Open before any reply: the first reply draws it full.
  const ui = await mount($)
  await turn($)
  expect(await read(ui)).toMatchObject({ label: '5m left', filled: 24 })

  await clock.advance(125 * SECOND)
  expect(await read(ui)).toMatchObject({ label: '3m left', filled: 14 })
  await turn($)
  expect(await read(ui)).toMatchObject({ label: '5m left', color: EMERALD, filled: 24 })
  await ui.unmount()
})

test('the redraws stop once the cache has expired', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('5m'), clock)
  const at = redraws(on, clock)
  await start($)
  await turn($)
  await pressKeepWarm($)
  await clock.advance(5 * MINUTE + 10 * SECOND)
  const n = at.length
  await clock.advance(30 * MINUTE)
  expect(at.length).toBe(n)
  expect((await look($)).label).toBe('expired')
  expect(w.pings.length).toBe(0)

  // The next reply starts them again.
  await turn($)
  const m = at.length
  await clock.advance(10 * SECOND)
  expect(at.length).toBe(m + 1)
  expect((await look($)).label).toBe('5m left')
})

test('no redraws while there is no bar', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  world($, on, row('1h'), clock)
  const at = redraws(on, clock)
  await start($)
  await clock.advance(60 * MINUTE)
  expect(at.length).toBe(0)

  await turn($)
  await clock.advance(10 * MINUTE)
  await clear($)
  let n = at.length
  await clock.advance(60 * MINUTE)
  expect(at.length).toBe(n)

  await turn($)
  await clock.advance(10 * MINUTE)
  await compact($, 'manual')
  n = at.length
  await clock.advance(60 * MINUTE)
  expect(at.length).toBe(n)

  await turn($)
  n = at.length
  await clock.advance(45 * SECOND)
  expect(at.length).toBe(n + 1)
})

test('a tier set mid-countdown keeps the checks on the cache refresh', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('5m'), clock)
  const at = redraws(on, clock)
  await start($)
  const A = clock.now()
  await turn($)
  await clock.advance(127 * SECOND)
  await cacheTtl($, '1h')
  at.length = 0
  await clock.advance(MINUTE)
  expect(at).toEqual([A + 135 * SECOND, A + 180 * SECOND])
  await clock.advance(55 * MINUTE)
  expect(w.pingAt).toEqual([A + 54 * MINUTE])
})

test('a tier read seconds after the request keeps the redraws and the ping on the request', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('5m'), clock)
  const at = redraws(on, clock)
  await start($)
  await turn($)
  await clock.advance(2 * MINUTE)
  // This request writes the 1-hour tier; the transcript says so only at
  // the end of the turn.
  const A = clock.now()
  await beginTurn($)
  await clock.advance(3 * SECOND)
  w.transcript = row('1h')
  await endTurn($)
  at.length = 0
  await clock.advance(90 * SECOND)
  expect(at).toEqual([A + 45 * SECOND, A + 90 * SECOND])
  await clock.advance(55 * MINUTE - 90 * SECOND)
  expect(w.pingAt).toEqual([A + 54 * MINUTE])
})

test('a late 1-hour tier with no timer left still pings on time', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('5m'), clock)
  await start($)
  await turn($)
  await clock.advance(2 * MINUTE)
  // This request takes 6 minutes, so the 5-minute countdown has ended and no
  // timer is left when the transcript reveals the 1-hour tier.
  w.stepDelay = 6 * MINUTE
  const A = clock.now()
  await $.turn.start({ text: 'x', turnId: 't' } as any)
  const done = step($)
  await clock.advance(6 * MINUTE)
  await done
  w.transcript = row('1h')
  await endTurn($)
  await clock.advance(55 * MINUTE)
  expect(w.pingAt).toEqual([A + 54 * MINUTE])
})

test('no ping goes out once the cache has expired', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('5m'), clock)
  w.dropPings = 100
  await start($)
  const A = clock.now()
  await turn($)
  await clock.advance(10 * MINUTE)
  expect(w.pingAt).toEqual([A + 270 * SECOND, A + 280 * SECOND, A + 290 * SECOND])
})

test('on a 5-minute cache a dropped ping is tried again one tick later', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('5m'), clock)
  w.dropPings = 1
  await start($)
  await turn($)
  await clock.advance(13 * SECOND)
  const A = clock.now()
  await turn($)
  await clock.advance(290 * SECOND)
  expect(w.pingAt).toEqual([A + 270 * SECOND, A + 280 * SECOND])
})

test('a slow request counts from when it went out', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('5m'), clock)
  await start($)
  w.stepDelay = 20 * SECOND
  const A = clock.now()
  const done = turn($)
  await clock.advance(20 * SECOND)
  await done
  await clock.advance(250 * SECOND - 1)
  expect(w.pings.length).toBe(0)
  await clock.advance(1)
  expect(w.pingAt).toEqual([A + 270 * SECOND])
})

// Never while someone is busy

test('no ping while Claude is working', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  await start($)
  await turn($)
  await clock.advance(50 * MINUTE)
  await $.turn.start({ text: 'x', turnId: 't2' } as any)
  await clock.advance(10 * MINUTE)
  expect(w.pings.length).toBe(0)
})

test('a prompt waiting for its turn holds the ping back', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  await start($)
  await turn($)
  await clock.advance(53.9 * MINUTE)
  await person($)
  await clock.advance(MINUTE)
  expect(w.pings.length).toBe(0)
})

test('a queued prompt removed before its turn stops holding pings back', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  await start($)
  await beginTurn($)
  // Queued behind the running turn, then removed: no turn of its own.
  await person($)
  await endTurn($)
  await clock.advance(55 * MINUTE)
  expect(w.pings.length).toBe(1)
})

test('a prompt a hook beneath failed on stops holding pings back', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  await start($)
  await turn($)
  await person($, 'boom').catch(() => undefined)
  await clock.advance(55 * MINUTE)
  expect(w.pings.length).toBe(1)
})

// When keep warm stops

// Each ping's reply refreshes the cache, so pings go out every 270 seconds on
// 5m (6 in the 30 minutes) and every 54 minutes on 1h (13 in the 12 hours).
for (const [tier, pings, last] of [['5m', 6, 1620 * SECOND], ['1h', 13, 702 * MINUTE]] as const) {
  test(`on a ${tier} cache keep warm stops ${tier === '5m' ? '30 minutes' : '12 hours'} after the last message`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = world($, on, row(tier), clock)
    w.pingReplies = true
    await start($)
    await person($)
    const A = clock.now()
    await turn($)
    await clock.advance(16 * 60 * MINUTE)
    expect(w.pings.length).toBe(pings)
    expect(w.pingAt.at(-1)).toBe(A + last)
  })
}

test('the limit counts from the last message, not the session start', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('5m'))
  w.pingReplies = true
  await start($)
  await person($)
  await turn($)
  await clock.advance(1620 * SECOND)
  expect(w.pings.length).toBe(6)
  await person($)
  await turn($)
  await clock.advance(1620 * SECOND)
  expect(w.pings.length).toBe(12)
})

test('each message gives keep warm another 30 minutes', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('5m'))
  w.pingReplies = true
  await start($)
  await person($)
  await turn($)
  await clock.advance(1200 * SECOND)
  expect(w.pings.length).toBe(4)
  await person($)
  await turn($)
  await clock.advance(4 * 60 * MINUTE)
  expect(w.pings.length).toBe(10)
  await person($)
  await turn($)
  await clock.advance(4 * 60 * MINUTE)
  expect(w.pings.length).toBe(16)
})

test('a typed slash command gives keep warm another 30 minutes', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('5m'))
  w.pingReplies = true
  await start($)
  await person($)
  await turn($)
  await clock.advance(1200 * SECOND)
  expect(w.pings.length).toBe(4)
  // Pings go out every 270 seconds; the last inside 1200 + 1800 seconds is
  // the 11th, at 2970.
  await $.prompt.submit({ text: '/help', command: { name: 'help', args: '' }, origin: { kind: 'composer' } } as any)
  await clock.advance(4 * 60 * MINUTE)
  expect(w.pings.length).toBe(11)
})

// The reply comes d after the message; the last ping inside the limit is
// still sent, one just past it is not.
for (const [tier, d, pings] of [
  ['5m', 179 * SECOND, 6], ['5m', 180 * SECOND, 6], ['5m', 181 * SECOND, 5],
  ['1h', 17 * MINUTE, 13], ['1h', 18 * MINUTE, 13], ['1h', 19 * MINUTE, 12],
] as const) {
  const after = tier === '5m' ? `${d / SECOND}s` : `${d / MINUTE} minutes`
  test(`on a ${tier} cache a reply ${after} after the message leaves ${pings} pings`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = world($, on, row(tier))
    w.pingReplies = true
    await start($)
    await person($)
    await clock.advance(d)
    await turn($)
    await clock.advance(16 * 60 * MINUTE)
    expect(w.pings.length).toBe(pings)
  })
}

test('the cache size and model never stop keep warm early', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('5m'))
  w.usage = { read: 1_000_000, write: 0, input: 1_000_000, output: 1_000_000, model: 'claude-haiku-5-5' }
  w.pingReplies = true
  await start($)
  await person($)
  await turn($)
  await clock.advance(4 * 60 * MINUTE)
  expect(w.pings.length).toBe(6)

  w.transcript = row('1h')
  await person($)
  await turn($)
  await clock.advance(16 * 60 * MINUTE)
  expect(w.pings.length).toBe(6 + 13)
})

test('/cache-ttl 5m on a 1-hour transcript stops keep warm after 30 minutes', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  w.pingReplies = true
  await start($)
  await cacheTtl($, '5m')
  await person($)
  await turn($)
  await clock.advance(4 * 60 * MINUTE)
  expect(w.pings.length).toBe(6)
})

test('once keep warm has stopped and the cache expires, the redraws stop', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('5m'), clock)
  w.pingReplies = true
  const at = redraws(on, clock)
  await start($)
  await person($)
  await turn($)
  await clock.advance(1920 * SECOND)
  expect(w.pings.length).toBe(6)
  expect((await look($)).label).toBe('expired')
  const n = at.length
  await clock.advance(60 * MINUTE)
  expect(at.length).toBe(n)
})

// The button

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the keep-warm button has no hotkey on ${surface}`, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    world($, on, row('1h'))
    await start($, surface)
    await turn($)
    const ui = await mount($, surface)
    const button = await ui.find({ key: 'keep-warm' })
    expect(button?.props.hotkey).toBe(undefined)
    expect(button?.text).toBe('[✓] keep warm')
    await ui.press({ key: 'keep-warm' })
    expect((await read(ui)).button).toBe('[ ] keep warm')
    await ui.unmount()
  })
}

test('the terminal shows a flame emoji (a same-width blank once expired), the desktop its flame icon', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  world($, on, row('5m'))
  await start($)
  await turn($)
  await pressKeepWarm($)
  let ui = await mount($)
  expect((await ui.findAll({ type: 'Text' }))[0]?.text).toBe('🔥 ')
  await ui.unmount()
  // The desktop draws the flame as an icon.
  ui = await mount($, 'desktop')
  expect((await ui.findAll({ type: 'Svg' })).some(svg => svg.props.alt === 'prompt cache')).toBe(true)
  await ui.unmount()

  await clock.advance(5 * MINUTE)
  ui = await mount($)
  expect((await read(ui)).label).toBe('expired')
  expect(await ui.find({ type: 'Text', text: /🔥/ })).toBeFalsy()
  // Two spaces stand in for the two-column emoji.
  expect((await ui.findAll({ type: 'Text' }))[0]?.text).toBe('   ')
  await ui.unmount()
})

// Starting over

test('/clear near the renew point hides the bar and sends no ping', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  engineStandIn(on)
  await start($)
  await turn($)
  await pressKeepWarm($)

  await clock.advance(50 * MINUTE)
  await clear($)
  await clock.advance(10 * MINUTE)
  expect(w.pings.length).toBe(0)
  expect(await isHidden($)).toBe(true)

  // The new conversation starts with keep warm back on.
  await turn($)
  expect((await look($)).button).toMatch(/\[✓\]/)
  await clock.advance(55 * MINUTE)
  expect(w.pings.length).toBe(1)
})

test('/compact hides the bar until the next request', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  engineStandIn(on)
  await start($)
  await turn($)
  await clock.advance(50 * MINUTE)
  await compact($, 'manual')
  expect(await isHidden($)).toBe(true)
  await clock.advance(10 * MINUTE)
  expect(w.pings.length).toBe(0)

  await turn($)
  expect((await look($)).label).toBe('60m left')
})

test('/clear hides the bar even with a pinned tier', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  engineStandIn(on)
  await start($)
  await cacheTtl($, '5m')
  await turn($)
  expect((await look($)).label).toBe('5m left')

  await clear($)
  expect(await isHidden($)).toBe(true)
  await clock.advance(10 * MINUTE)
  expect(w.pings.length).toBe(0)

  await turn($)
  expect((await look($)).label).toBe('5m left')
})

test('after /clear the next reply brings the bar back on its own tier', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  engineStandIn(on)
  await start($)
  await turn($)
  expect((await look($)).label).toBe('60m left')
  await clock.advance(20 * MINUTE)
  await clear($)
  expect(await isHidden($)).toBe(true)

  w.transcript = row('5m')
  await turn($)
  const after = await look($)
  expect(after.label).toBe('5m left')
  expect(after.filled).toBe(24)
  await clock.advance(270 * SECOND)
  expect(w.pings.length).toBe(1)
})

test('/clear resets the tier, so a new transcript not yet readable keeps the bar hidden', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  engineStandIn(on)
  await start($)
  await turn($)
  expect((await look($)).label).toBe('60m left')
  await clear($)

  // The new reply's request has gone out, but its tier can't be read yet.
  w.transcript = null
  await beginTurn($)
  expect(await isHidden($)).toBe(true)

  w.transcript = row('5m')
  await endTurn($)
  expect((await look($)).label).toBe('5m left')
})

test('a precompute compaction does not hide the bar', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  engineStandIn(on)
  await start($)
  await turn($)
  await clock.advance(50 * MINUTE)
  await compact($, 'precompute')
  expect(await isHidden($)).toBe(false)
  expect((await look($)).label).toBe('10m left')
  await clock.advance(4 * MINUTE)
  expect(w.pings.length).toBe(1)
})

test('a skipped compaction does not hide the bar', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  w.compactSkip = true
  engineStandIn(on)
  await start($)
  await turn($)
  await clock.advance(50 * MINUTE)
  await compact($, 'manual')
  expect(await isHidden($)).toBe(false)
  expect((await look($)).label).toBe('10m left')
  await clock.advance(4 * MINUTE)
  expect(w.pings.length).toBe(1)
})

test('a subagent compaction does not hide the bar', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  engineStandIn(on)
  await start($)
  await turn($)
  await clock.advance(50 * MINUTE)
  await compact($, 'auto', 'a')
  expect(await isHidden($)).toBe(false)
  expect((await look($)).label).toBe('10m left')
  await clock.advance(4 * MINUTE)
  expect(w.pings.length).toBe(1)
})

test('an auto compaction on a 5-minute cache hides the bar until the next reply', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('5m'))
  engineStandIn(on)
  await start($)
  await turn($)
  await clock.advance(200 * SECOND)
  await compact($, 'auto')
  expect(await isHidden($)).toBe(true)
  await clock.advance(10 * MINUTE)
  expect(w.pings.length).toBe(0)

  await turn($)
  const after = await look($)
  expect(after.label).toBe('5m left')
  expect(after.filled).toBe(24)
  await clock.advance(270 * SECOND)
  expect(w.pings.length).toBe(1)
})

test('keep warm off survives a compaction but not /clear', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world($, on, row('1h'))
  await start($)
  await turn($)
  await pressKeepWarm($)
  await compact($, 'manual')
  await turn($)
  expect((await look($)).button).toMatch(/\[ \]/)
  await clock.advance(55 * MINUTE)
  expect(w.pings.length).toBe(0)

  await clear($)
  await turn($)
  expect((await look($)).button).toMatch(/\[✓\]/)
  await clock.advance(55 * MINUTE)
  expect(w.pings.length).toBe(1)
})
