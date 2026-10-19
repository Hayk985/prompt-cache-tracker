import type { EngineInterface, Register } from 'claude-code'

type Ttl = '5m' | '1h'
type TtlMode = 'auto' | Ttl

const MINUTE = 60_000
const TTL_MS: Record<Ttl, number> = { '5m': 5 * MINUTE, '1h': 60 * MINUTE }
// Redraws: under a minute, so no minute of the label is skipped; faster on 5m
// so the bar doesn't jump. Each divides its tier's lifetime and 10% of it.
const TICK: Record<Ttl, number> = { '5m': 10_000, '1h': 45_000 }
// Renew at 10% left.
const RENEW_SHARE = 0.1
// Keep warm stops after this long with no message from the person.
const IDLE_LIMIT: Record<Ttl, number> = { '5m': 30 * MINUTE, '1h': 12 * 60 * MINUTE }
// When $.fs.read refuses the transcript (too big), only its last TAIL_BYTES are read.
const TAIL_BYTES = 2_000_000

const BAR_CELLS = 24
// An emoji keeps its own colors, so an expired cache shows a blank of the
// same width instead of a lit flame.
const FLAME = '🔥'
const FLAME_BLANK = '  '
const EXPIRED = '#6b6a64'
const TRACK = '#3a3a37'

const PING = 'Warming up (just reply ok)'

// Emerald at full, Leaf at 75%, yellow at half, red when empty.
const STOPS: [number, number, number, number][] = [
  [1, 158, 64, 52],
  [0.75, 110, 70, 50],
  [0.5, 48, 96, 53],
  [0, 0, 84, 60],
]

export function colorAt(fraction: number): string {
  const p = Math.min(1, Math.max(0, fraction))
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [hi, h1, s1, l1] = STOPS[i]!
    const [lo, h2, s2, l2] = STOPS[i + 1]!
    if (p >= lo) {
      const k = (p - lo) / (hi - lo)
      return hslToHex(h2 + (h1 - h2) * k, s2 + (s1 - s2) * k, l2 + (l1 - l2) * k)
    }
  }
  const [, h, s, l] = STOPS[STOPS.length - 1]!
  return hslToHex(h, s, l)
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100
  const lig = l / 100
  const a = sat * Math.min(lig, 1 - lig)
  const channel = (n: number) => {
    const k = (n + h / 30) % 12
    const v = lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}

// How long before expiry the ping goes out.
export function renewAt(tier: Ttl): number {
  return TTL_MS[tier] * RENEW_SHARE
}

function label(remainingMs: number): string {
  if (remainingMs <= 0) return 'expired'
  return `${Math.ceil(remainingMs / MINUTE)}m left`
}

function flameSvg(color: string, isExpired: boolean): string {
  const expired = isExpired ? '<path d="M3 3l18 18"/>' : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M12 12c2-2.96 0-7-1-8 0 3.038-1.773 4.741-3 6-1.226 1.26-2 3.24-2 5a6 6 0 1 0 12 0c0-1.532-1.056-3.94-2-5-1.786 3-2.791 3-4 2z"/>` +
    `${expired}</svg>`
  )
}

function barSvg(color: string, fraction: number): string {
  const w = 200
  const filled = Math.round(w * Math.min(1, Math.max(0, fraction)))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 6">` +
    `<rect width="${w}" height="6" rx="3" fill="${TRACK}"/>` +
    (filled > 0 ? `<rect width="${filled}" height="6" rx="3" fill="${color}"/>` : '') +
    `</svg>`
  )
}

// Module state: starts over whenever the engine loads the module again (a
// reload while developing, or a lost hooks worker), like a new session.
let anchorAt: number | null = null
let ttlMode: TtlMode = 'auto'
// What the transcript says the last cache write used; null until it says.
let writtenTier: Ttl | null = null
let keepWarm = true
let mainBusy = false
// A person's prompt has gone in and its turn hasn't started.
let isPromptPending = false
let lastHumanAt = 0
let pingedFor: number | null = null
// The session's log file, found by the session id it is named for; /clear
// starts a new id and so a new file.
let transcriptPath = ''
let transcriptFor = ''
let tick: { cancel: () => void } | null = null

// The tier the countdown follows: the person's pick, else the transcript's.
function tierNow(): Ttl | null {
  return ttlMode !== 'auto' ? ttlMode : writtenTier
}

// A fresh conversation: no cache yet, keep warm back on, bar hidden until a
// reply says which tier the new cache is on.
function resetConversation() {
  anchorAt = null
  writtenTier = null
  pingedFor = null
  keepWarm = true
  mainBusy = false
  isPromptPending = false
}

function toggleKeepWarm($: EngineInterface) {
  keepWarm = !keepWarm
  $.ui.invalidate('ui.render')
}

const CACHE_NAME: Record<Ttl, string> = { '5m': '5-minute', '1h': '1-hour' }

// Schedules the next redraw and check on the cache refresh plus whole ticks,
// so one lands exactly on the renew point and the last on expiry. Nothing to
// count (no bar, or expired): no timer. While the bar shows it keeps
// redrawing until expiry, even once pinging is done.
async function startTick($: EngineInterface) {
  const t = await $.clock.now()
  tick?.cancel()
  tick = null
  const anchor = anchorAt
  const tier = tierNow()
  if (anchor === null || tier === null) return
  const next = anchor + (Math.floor(Math.max(0, t - anchor) / TICK[tier]) + 1) * TICK[tier]
  if (next > anchor + TTL_MS[tier]) return
  tick = $.clock.after(next - t, async () => {
    await startTick($)
    await renewIfDue($)
  })
}

// No cache to count until the next reply: hide the bar and stop the timer.
async function hideBar($: EngineInterface) {
  anchorAt = null
  $.ui.invalidate('ui.render')
  await startTick($)
}

async function setWrittenTier($: EngineInterface, tier: Ttl) {
  if (tier === writtenTier) return
  writtenTier = tier
  $.ui.invalidate('ui.render')
  await startTick($)
}

// The newest main-thread cache write in the transcript says which tier the
// request asked for: Claude Code splits it into 1h and 5m tokens. 1-hour
// entries must come before 5-minute ones in a request, so any 5-minute write
// is the conversation's end, which expires first.
export function tierFromTranscript(text: string): Ttl | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('"cache_creation"')) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue // The tail can start mid-line.
    }
    if (row?.type !== 'assistant' || row.isSidechain) continue
    if (row.message?.model === '<synthetic>') continue
    const written = row.message?.usage?.cache_creation
    if (Number(written?.ephemeral_5m_input_tokens) > 0) return '5m'
    if (Number(written?.ephemeral_1h_input_tokens) > 0) return '1h'
  }
  return null
}

async function readTranscriptTier($: EngineInterface, path: string): Promise<Ttl | null> {
  if (!path) return null
  let text: string
  try {
    text = await $.fs.read(path)
  } catch {
    // Too big for one read (or gone): read only its end.
    try {
      const tail = await $.process.run(['tail', '-c', String(TAIL_BYTES), path])
      if (tail.exitCode !== 0) return null
      text = tail.stdout
    } catch {
      return null
    }
  }
  return tierFromTranscript(text)
}

// Where Claude Code keeps the session's log: projects/<folder>/<session id>.jsonl.
// The same id in two folders (a session resumed elsewhere): the newest file.
const FIND_TRANSCRIPT = 'ls -t "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$1".jsonl 2>/dev/null | head -n 1'

async function findTranscript($: EngineInterface): Promise<string> {
  const id = await $.session.id()
  if (id === transcriptFor) return transcriptPath
  const found = await $.process.run(['sh', '-c', FIND_TRANSCRIPT, 'sh', id])
  const path = found.exitCode === 0 ? found.stdout.trim() : ''
  // Not written yet: look again next time.
  if (path) {
    transcriptPath = path
    transcriptFor = id
  }
  return path
}

// Reads the transcript and follows its tier. A read that finds nothing keeps
// a tier already known; with none known the bar stays hidden.
async function checkTranscript($: EngineInterface) {
  const tier = await readTranscriptTier($, await findTranscript($))
  if (tier !== null) await setWrittenTier($, tier)
}

async function renewIfDue($: EngineInterface) {
  const t = await $.clock.now()
  $.ui.invalidate('ui.render')
  const anchor = anchorAt
  const tier = tierNow()
  if (anchor === null || tier === null) return
  if (mainBusy || isPromptPending || !keepWarm || anchor === pingedFor) return
  if (t - lastHumanAt > IDLE_LIMIT[tier]) return
  const remaining = anchor + TTL_MS[tier] - t
  if (remaining <= 0 || remaining > renewAt(tier)) return

  pingedFor = anchor
  let result
  try {
    result = await $.prompt.submit({ text: PING })
  } catch {
    result = { drop: 'failed' }
  }
  if (result.drop !== undefined) {
    // Refused or failed to start: let the next tick try again.
    if (pingedFor === anchor) pingedFor = null
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('ttlMode')
    if (stored === '5m' || stored === '1h' || stored === 'auto') ttlMode = stored
    resetConversation()
    lastHumanAt = await $.clock.now()
    await startTick($)

    await $.command.register({
      name: 'keep-warm',
      description: 'Turn automatic cache refresh on or off',
    })
    await $.command.register({
      name: 'cache-ttl',
      description: 'Choose a 5-minute or 1-hour cache for the progress bar, or detect it automatically',
      argumentHint: 'auto | 5m | 1h',
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind
    const isPerson = kind === 'composer' || kind === 'bridge' || kind === 'sdk'
    if (isPerson) {
      lastHumanAt = await $.clock.now()
      // Hold off a ping from Enter until the turn starts.
      if (!e.command) isPromptPending = true
    }
    let result
    try {
      result = await next(e)
    } catch (error) {
      if (isPerson) isPromptPending = false
      throw error
    }
    // A prompt something dropped starts no turn.
    if (isPerson && result.drop !== undefined) isPromptPending = false
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      resetConversation()
      await hideBar($)
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    // The compacted conversation no longer uses the old cache; the next
    // request starts a new one.
    if (e.agentId === undefined && e.trigger !== 'precompute' && !('skip' in result && result.skip)) {
      pingedFor = null
      await hideBar($)
    }
    return result
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      mainBusy = true
      isPromptPending = false
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      mainBusy = false
      // A queued prompt removed before its turn started leaves no turn of its
      // own; the turn it waited behind ends here.
      isPromptPending = false
      // The turn's rows are in the log by now. The turn's end waits on this,
      // so a failed read must never hold it.
      await checkTranscript($).catch(() => undefined)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const stepStartedAt = await $.clock.now()
    const result = yield* next(e)
    const usage = result.usage
    if (usage === null) return result

    // No cache touched (caching off, or too short to cache): nothing to count.
    if (usage.cache_read_input_tokens + usage.cache_creation_input_tokens === 0) return result

    // The cache entry was refreshed when the request went out, not when the
    // reply finished streaming.
    anchorAt = stepStartedAt
    $.ui.invalidate('ui.render')
    await startTick($)
    void checkTranscript($).catch(() => undefined)
    return result
  })

  on('command.run', { command: 'keep-warm' }, async $ => {
    toggleKeepWarm($)
    return { text: `Keep warm is ${keepWarm ? 'on' : 'off'}.` }
  })

  on('command.run', { command: 'cache-ttl' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg !== 'auto' && arg !== '5m' && arg !== '1h') {
      const current = tierNow()
      return {
        text: current
          ? `Tracking the ${CACHE_NAME[current]} cache. Change it with /cache-ttl 5m, 1h or auto.`
          : 'Waiting for your first reply to detect the cache.',
      }
    }
    ttlMode = arg
    await $.store.set('ttlMode', arg)
    $.ui.invalidate('ui.render')
    await startTick($)
    return { text: arg === 'auto' ? 'Detecting the cache automatically.' : `Tracking the ${CACHE_NAME[arg]} cache.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Shown only once a reply has made a cache and its tier is known.
    const anchor = anchorAt
    const tier = tierNow()
    if (e.props.hasSurvey || anchor === null || tier === null) return next(e)

    const toggle = () => toggleKeepWarm($)
    const t = Math.max(await $.clock.now(), anchor)
    const check = `${keepWarm ? '[✓]' : '[ ]'} keep warm`
    const total = TTL_MS[tier]
    const remaining = anchor + total - t
    const fraction = remaining / total
    const isExpired = remaining <= 0
    const color = isExpired ? EXPIRED : colorAt(fraction)
    const text = label(remaining)

    if (e.surface === 'terminal') {
      const { Box, Text, Button } = $.ui.resolve(e)
      const filled = isExpired ? 0 : Math.max(1, Math.round(BAR_CELLS * fraction))
      return (
        // One empty row above, to match the engine's row under the band.
        <Box flexDirection="row" width={e.props.bodyColumns} marginTop={1}>
          <Text>{isExpired ? FLAME_BLANK : FLAME}{' '}</Text>
          <Text color={color}>{'━'.repeat(filled)}</Text>
          <Text color={TRACK}>{'━'.repeat(BAR_CELLS - filled)}</Text>
          <Text color={color}>  {text}</Text>
          <Box flexGrow={1} />
          <Button key="keep-warm" plain dimColor={!keepWarm} onPress={toggle}>
            {check}
          </Button>
        </Box>
      )
    }

    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {/* A row of its own, so the desktop centers the icon on the text. */}
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg source={flameSvg(color, isExpired)} alt="prompt cache" width={16} height={16} />
          <Svg source={barSvg(color, isExpired ? 0 : fraction)} alt={text} width={200} height={6} />
          <Text color={color}>{text}</Text>
        </Box>
        <Box flexGrow={1} />
        <Button key="keep-warm" plain dimColor={!keepWarm} onPress={toggle}>
          {check}
        </Button>
      </Box>
    )
  })
}
