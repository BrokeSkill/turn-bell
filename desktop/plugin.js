import { Button, COMPOSER_AREAS, Codicon, Popover, PopoverContent, PopoverTrigger, host, icons } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'turn-bell'
const MODE_KEY = 'mode'
const DEBOUNCE_MS = 2500
const MODES = [
  { id: 'off', label: 'Off', hint: 'No notifications', icon: 'Moon' },
  { id: 'turn', label: 'Current turn', hint: 'Ping when the turn you are watching finishes', icon: 'Bell' },
  { id: 'all', label: 'All turns', hint: 'Ping on every finished turn', icon: 'Bell' }
]
const MODE_INDEX = { off: 0, turn: 1, all: 2 }

let storage = null
let rest = null
let timerHost = null
let armTimer = null

const listeners = new Set()
const fires = new Map()
let pending = []
let lastSend = null
let mode = 'off'
let infoModel = ''

const CSS = `
.tb-trigger{order:1;width:var(--composer-control-size);height:var(--composer-control-size);flex-shrink:0;border-radius:.375rem;color:var(--ui-text-tertiary)}
.tb-trigger[data-mode=turn]{color:var(--ui-accent)}
.tb-trigger[data-mode=all]{color:var(--ui-success,var(--ui-accent))}
.tb-wrap{position:relative;display:flex;align-items:center;justify-content:center}
.tb-dot{position:absolute;top:2px;right:2px;width:5px;height:5px;border-radius:999px;background:var(--ui-accent);box-shadow:0 0 0 2px var(--ui-bg-elevated)}
.tb-panel{display:flex;flex-direction:column;gap:10px;min-width:238px}
.tb-head{display:flex;flex-direction:column;gap:2px}
.tb-title{font-size:12px;font-weight:600;color:var(--ui-text-primary)}
.tb-sub{font-size:10px;color:var(--ui-text-quaternary)}
.tb-modes{display:flex;flex-direction:column;gap:2px}
.tb-mode{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;width:100%;padding:6px 7px;border:0;border-radius:6px;background:transparent;color:var(--ui-text-secondary);text-align:left;cursor:pointer}
.tb-mode:hover{background:var(--chrome-action-hover);color:var(--ui-text-primary)}
.tb-mode[data-active=true]{background:color-mix(in srgb,var(--ui-accent) 10%,transparent);color:var(--ui-text-primary)}
.tb-mode-label{font-size:11.5px;font-weight:550}
.tb-mode-hint{font-size:10px;color:var(--ui-text-quaternary);margin-top:1px}
.tb-glyph{display:flex;align-items:center;justify-content:center;width:13px;height:13px;flex-shrink:0}
.tb-foot{display:flex;flex-direction:column;gap:5px;border-top:1px solid var(--ui-stroke-secondary);padding-top:9px}
.tb-line{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:10px}
.tb-key{color:var(--ui-text-quaternary)}
.tb-val{color:var(--ui-text-tertiary);font-family:var(--font-mono,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb-status{font-size:10px;line-height:1.45}
.tb-status[data-tone=ok]{color:var(--ui-success,var(--ui-accent))}
.tb-status[data-tone=bad]{color:var(--ui-danger,var(--ui-text-secondary))}
`

function readMode() {
  const stored = storage ? storage.get(MODE_KEY, 'off') : 'off'
  return stored in MODE_INDEX ? stored : 'off'
}

function nextMode(current) {
  const order = ['off', 'turn', 'all']
  return order[(order.indexOf(current) + 1) % order.length]
}

function firstLine(value) {
  const text = typeof value === 'string' ? value : ''
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^\s*(?:[-*+]\s+|#{1,6}\s+|>+\s*)/, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (line) {
      return line.length > 140 ? `${line.slice(0, 137)}...` : line
    }
  }
  return ''
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return ''
  }
  const seconds = ms / 1000
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}

function formatCount(value) {
  const count = Number(value)
  if (!Number.isFinite(count) || count <= 0) {
    return ''
  }
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}

function outcomeOf(event) {
  const payload = event && typeof event.payload === 'object' && event.payload ? event.payload : {}
  if (payload.status === 'error' || payload.error) {
    return 'error'
  }
  if (payload.status === 'interrupted') {
    return 'interrupted'
  }
  return 'complete'
}

function turnStart(sessionId) {
  if (sessionId && fires.has(sessionId)) {
    return fires.get(sessionId)
  }
  const values = [...fires.values()]
  return values.length ? values[values.length - 1] : null
}

function summaryFor(event) {
  const payload = event && typeof event.payload === 'object' && event.payload ? event.payload : {}
  const status = outcomeOf(event)
  const model = (payload.usage && payload.usage.model) || host.state.model.get() || infoModel
  const duration = formatDuration(Date.now() - turnStart(event.session_id))
  const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : {}
  const counts = [formatCount(usage.input || usage.prompt), formatCount(usage.output || usage.completion)].filter(Boolean)
  const preview = firstLine(payload.text) || firstLine(payload.error) || 'No output'
  const cost = Number(usage.cost_usd) > 0 ? `$${Number(usage.cost_usd).toFixed(4)}` : ''
  const meta = [model, duration, counts.length ? `${counts.join(' in / ')} out` : '', cost].filter(Boolean).join('  |  ')
  const headline = status === 'error' ? 'Turn failed' : status === 'interrupted' ? 'Turn interrupted' : 'Turn complete'
  const detail = status === 'error' ? firstLine(payload.error) : ''
  const shared = preview && preview === detail
  const body = [
    shared ? '' : preview,
    `\`\`\`\n${meta}\n\`\`\``,
    detail ? (shared ? `**Error**\n\`\`\`\n${detail}\n\`\`\`` : `\`\`\`\n${detail}\n\`\`\``) : ''
  ].filter(Boolean).join('\n\n')
  return {
    status,
    preview,
    body,
    title: model ? `${headline} · ${model}` : headline
  }
}

function arm() {
  if (!timerHost) {
    return
  }
  if (armTimer) {
    armTimer()
  }
  armTimer = timerHost.setTimeout(() => {
    armTimer = null
    void deliver()
  }, DEBOUNCE_MS)
}

async function deliver() {
  const batch = pending
  pending = []
  if (!batch.length || !rest) {
    return
  }
  const failing = batch.filter(item => item.status === 'error')
  const failed = batch.length > 1 ? batch.length : 0
  const lead = failed
    ? `${batch.length} turns finished . ${failing.length} failed`
    : batch[batch.length - 1].preview
  const body = batch.length === 1
    ? batch[0].body
    : [`**${lead}**`, ...batch.map(item => `${item.status === 'error' ? 'x' : '-'} ${item.preview}`)].join('\n')
  const request = {
    title: batch.length === 1 ? batch[0].title : `${batch.length} turns finished`,
    message: body,
    priority: failing.length ? 'high' : 'default',
    tags: failing.length ? ['warning'] : batch.length > 1 ? ['package'] : ['white_check_mark']
  }
  try {
    const result = await rest('/notify', { method: 'POST', body: request })
    lastSend = { ok: true, at: Date.now(), topic: result && result.topic ? result.topic : '', error: '' }
  } catch (error) {
    lastSend = { ok: false, at: Date.now(), topic: '', error: String((error && error.message) || error) }
  }
  listeners.forEach(fn => fn())
}

function onTurnEvent(event) {
  if (!event || typeof event.type !== 'string') {
    return
  }
  const sessionId = event.session_id
  if (event.type === 'message.start') {
    fires.set(sessionId || 'active', Date.now())
    return
  }
  if (event.type === 'session.info') {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
    if (payload.model) {
      infoModel = payload.model
    }
    if (payload.running) {
      fires.set(sessionId || payload.stored_session_id || 'active', Date.now())
    }
    return
  }
  if (event.type !== 'message.complete') {
    return
  }
  if (sessionId ? !fires.has(sessionId) : fires.size === 0) {
    return
  }
  const summary = summaryFor(event)
  fires.delete(sessionId)
  const current = readMode()
  if (current === 'off') {
    return
  }
  if (current === 'turn' && sessionId && host.state.focusedSessionId.get() && sessionId !== host.state.focusedSessionId.get()) {
    return
  }
  pending.push(summary)
  arm()
}

function useTurnBell() {
  const [current, setCurrent] = useState(() => readMode())

  useEffect(() => {
    const sync = () => setCurrent(readMode())
    listeners.add(sync)
    return () => {
      listeners.delete(sync)
    }
  }, [])

  const cycle = useCallback(() => {
    const next = nextMode(readMode())
    mode = next
    if (storage) {
      storage.set(MODE_KEY, next)
    }
    listeners.forEach(fn => fn())
  }, [])

  return { current, cycle }
}

function StatusPanel({ onClose }) {
  const { current } = useTurnBell()
  const [status, setStatus] = useState(null)
  const [probe, setProbe] = useState(null)

  useEffect(() => {
    let live = true
    if (!rest) {
      return () => {
        live = false
      }
    }
    rest('/status')
      .then(value => {
        if (live) {
          setStatus(value)
        }
      })
      .catch(error => {
        if (live) {
          setStatus({ ok: false, error: String((error && error.message) || error) })
        }
      })
    return () => {
      live = false
    }
  }, [])

  const sendTest = useCallback(() => {
    setProbe('Sending...')
    if (!rest) {
      setProbe('Backend unavailable')
      return
    }
    rest('/notify', {
      method: 'POST',
      body: { title: 'Turn Bell · test', message: 'Test ping from the composer bell.', tags: ['bell'] }
    })
      .then(result => setProbe(result && result.topic ? `Sent to ${result.topic}` : 'Sent'))
      .catch(error => setProbe(String((error && error.message) || error)))
  }, [])

  const rows = [
    ['Topic', status && status.topic ? status.topic : status && status.ok === false ? 'unresolved' : '...'],
    ['Server', status && status.server ? status.server.replace(/^https?:\/\//, '') : '...'],
    ['Auth', status && status.auth ? status.auth : '...']
  ]

  return jsxs('div', {
    className: 'tb-panel',
    children: [
      jsxs('div', {
        className: 'tb-head',
        children: [
          jsx('div', { className: 'tb-title', children: 'Turn notifications' }),
          jsx('div', { className: 'tb-sub', children: 'Pings the ntfy topic Hermes is already configured for.' })
        ]
      }),
      jsx('div', {
        className: 'tb-modes',
        children: MODES.map(item =>
          jsxs(
            'button',
            {
              type: 'button',
              className: 'tb-mode',
              'data-active': String(item.id === current),
              onClick: () => {
                mode = item.id
                if (storage) {
                  storage.set(MODE_KEY, item.id)
                }
                listeners.forEach(fn => fn())
                onClose()
              },
              children: [
                jsx('span', { className: 'tb-glyph', children: jsx(icons[item.icon], { size: 13 }) }),
                jsxs('span', {
                  children: [
                    jsx('span', { className: 'tb-mode-label', children: item.label }),
                    jsx('div', { className: 'tb-mode-hint', children: item.hint })
                  ]
                }),
                item.id === current ? jsx('span', { className: 'tb-glyph', children: jsx(Codicon, { name: 'check', size: '0.7rem' }) }) : null
              ]
            },
            item.id
          )
        )
      }),
      jsxs('div', {
        className: 'tb-foot',
        children: [
          ...rows.map(row =>
            jsxs(
              'div',
              {
                className: 'tb-line',
                children: [
                  jsx('span', { className: 'tb-key', children: row[0] }),
                  jsx('span', { className: 'tb-val', children: row[1] })
                ]
              },
              row[0]
            )
          ),
          jsxs(Button, {
            variant: 'outline',
            size: 'xs',
            className: 'w-full',
            onClick: sendTest,
            children: [jsx(Codicon, { name: 'send', size: '0.7rem' }), 'Send test ping']
          }),
          jsx('div', {
            className: 'tb-status',
            'data-tone': probe && /Sent/.test(probe) ? 'ok' : probe ? 'bad' : '',
            children: probe || (lastSend ? (lastSend.ok ? `Last ping sent to ${lastSend.topic}` : `Last ping failed: ${lastSend.error}`) : 'No ping sent yet')
          })
        ]
      })
    ]
  })
}

function Trigger() {
  const { current, cycle } = useTurnBell()
  const [open, setOpen] = useState(false)
  const hold = useRef(null)
  const swallow = useRef(false)
  const active = MODES[MODE_INDEX[current]]
  const title = `Turn notifications: ${active.label}`

  const down = useCallback(() => {
    hold.current = window.setTimeout(() => {
      hold.current = null
      swallow.current = true
      setOpen(true)
    }, 450)
  }, [])

  const release = useCallback(() => {
    if (hold.current) {
      window.clearTimeout(hold.current)
      hold.current = null
    }
  }, [])

  return jsxs(Popover, {
    open,
    onOpenChange: setOpen,
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: jsxs(Button, {
          className: 'tb-trigger',
          variant: 'ghost',
          size: 'icon',
          'data-mode': current,
          title,
          'aria-label': title,
          onPointerDown: down,
          onPointerUp: release,
          onPointerLeave: release,
          onPointerCancel: release,
          onClickCapture: event => {
            event.preventDefault()
            event.stopPropagation()
            if (swallow.current) {
              swallow.current = false
              return
            }
            cycle()
          },
          children: [
            jsx(icons[current === 'off' ? 'Moon' : 'Bell'], { size: 15 }),
            current === 'all' ? jsx('span', { className: 'tb-dot' }) : null
          ]
        })
      }),
      open
        ? jsx(PopoverContent, {
            side: 'top',
            align: 'end',
            sideOffset: 8,
            'aria-label': 'Turn notifications',
            children: jsx(StatusPanel, { onClose: () => setOpen(false) })
          })
        : null
    ]
  })
}

export default {
  id: ID,
  name: 'Turn Bell',
  description: 'Rings the configured ntfy topic when a turn finishes. Click the bell to cycle Off, Current turn, All turns.',
  register(ctx) {
    storage = ctx.storage
    rest = ctx.rest
    mode = readMode()
    infoModel = host.state.model.get() || ''

    if (typeof document !== 'undefined') {
      const style = document.createElement('style')
      style.textContent = CSS
      document.head.append(style)
      ctx.onDispose(() => style.remove())
    }

    timerHost = ctx

    ctx.onEvent('message.start', onTurnEvent)
    ctx.onEvent('message.complete', onTurnEvent)
    ctx.onEvent('session.info', onTurnEvent)

    const areas = COMPOSER_AREAS || {}
    const area = areas.actions || areas.leading || areas.bottom

    if (area) {
      ctx.register({
        id: 'composer-bell',
        area,
        order: 121,
        render: () => jsx(Trigger, {})
      })
    }
  }
}
