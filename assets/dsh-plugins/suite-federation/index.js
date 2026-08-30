/**
 * Suite federation for dsh.
 *
 * Joins Startup Suite as a runtime over the Phoenix socket, turns each
 * `attention` dispatch into an agent turn, and pushes the reply back.
 *
 * Tools are NOT bridged here — they arrive through the MCP surface
 * (`dsh-mcp-client`), which is the path OpenClaw and Claude Code already use
 * and the one whose bundles get adjusted. This plugin owns presence and
 * message flow only.
 *
 * One session per Suite space, held for the process lifetime, so a channel
 * conversation keeps its history the way a human participant would expect.
 */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { Socket } from 'phoenix'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'suite-federation'
export const inject = ['agents', 'agentDefaultModel', 'sessions']

export const Config = z.object({
  url: z.string().required(),
  runtimeId: z.string().required(),
  token: z.string().required(),
  version: z.string(),
})

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000

/** Collect the assistant text produced after `fromSeq`. */
function summarize(events, fromSeq) {
  let text = ''
  let reason
  let started = false
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
  let provider
  let model
  for (const event of events) {
    if (!started) {
      if (event.seq === undefined || event.seq >= fromSeq) started = true
      else continue
    }
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
      if (joined !== '') text = joined
      // Usage rides on assistant/message, one report per step, so a
      // multi-step turn must be summed rather than read off the last one.
      const u = event.data.usage
      if (u) {
        usage.inputTokens += u.inputTokens ?? 0
        usage.outputTokens += u.outputTokens ?? 0
        usage.cacheReadTokens += u.cacheReadTokens ?? 0
        usage.cacheWriteTokens += u.cacheWriteTokens ?? 0
      }
      const src = event.data.message?.source
      if (src?.provider) provider = src.provider
      if (src?.model) model = src.model
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason, usage, provider, model }
}

/** Render an inbound attention payload as the user turn the agent sees. */
function renderPrompt(payload) {
  const sig = payload.signal ?? {}
  const msg = payload.message ?? {}
  const space = payload.context?.space
  const lines = []
  if (space?.name) lines.push(`Suite space: ${space.name} (${sig.space_id})`)
  else if (sig.space_id) lines.push(`Suite space: ${sig.space_id}`)
  if (msg.author) lines.push(`From: ${msg.author}`)
  if (sig.reason) lines.push(`Reason: ${sig.reason}`)
  lines.push('')
  lines.push(msg.content ?? '')
  return lines.join('\n')
}

export function apply(ctx, config) {
  const url = config.url
  const runtimeId = config.runtimeId
  const token = config.token
  if (!url || !runtimeId || !token) {
    throw new Error('suite-federation: url, runtimeId and token are all required')
  }

  const logger = ctx.logger?.('suite-federation') ?? console

  // Captured at apply, when injection is guaranteed satisfied. Resolving these
  // from a socket callback instead returned undefined: the callback runs long
  // after this scope's effect, outside the window where ctx.get resolves.
  const services = {
    agents: ctx.get('agents'),
    defaultModel: ctx.get('agentDefaultModel'),
    sessions: ctx.get('sessions'),
  }
  process.stderr.write(
    `[suite-federation] SERVICES agents=${!!services.agents} model=${!!services.defaultModel} sessions=${!!services.sessions}\n`,
  )
  const sessionsBySpace = new Map()
  const inflight = new Set()
  const seen = new Set()

  let socket = null
  let channel = null
  let stopped = false
  let attempts = 0
  let reconnectTimer = null

  /** Get or create the long-lived agent for one Suite space. */
  async function agentForSpace(spaceId) {
    const existing = sessionsBySpace.get(spaceId)
    if (existing) return existing

    // The agent factory is registered by the agent-loop plugin, which may
    // still be mounting when the first dispatch lands. headless waits on the
    // loader for the same reason before it creates its one-shot agent.
    await ctx.get('loader')?.await()

    const agents = services.agents ?? ctx.get('agents')
    const defaultModel = services.defaultModel ?? ctx.get('agentDefaultModel')
    const selection = defaultModel.currentSelection()
    const { agent } = await agents.create({
      sessionId: SessionId(`session-suite-${spaceId}-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
    })
    await agent.whenIdle()
    sessionsBySpace.set(spaceId, agent)
    return agent
  }

  /** Run one dispatch to completion and push the reply. */
  async function handleAttention(payload) {
    const spaceId = payload.signal?.space_id
    if (!spaceId) return

    // One turn at a time per space: Suite can dispatch again while we think,
    // and two concurrent turns on one session interleave into nonsense.
    if (inflight.has(spaceId)) {
      logger.warn?.(`turn already running for ${spaceId}, dropping duplicate`)
      return
    }
    inflight.add(spaceId)
    const startedAt = Date.now()
    channel?.push('typing', { space_id: spaceId, typing: true })

    try {
      process.stderr.write('[suite-federation] TURN-START\n')
      const agent = await agentForSpace(spaceId)
      process.stderr.write('[suite-federation] AGENT-READY\n')
      const firstSeq = agent.session.seq
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: renderPrompt(payload) }],
          source: { kind: 'user' },
        }),
      )
      await agent.whenIdle()
      process.stderr.write('[suite-federation] TURN-IDLE\n')
      await (services.sessions ?? ctx.get('sessions')).flush(agent.session)

      const { text, reason, usage, provider, model } = summarize(
        agent.session.events,
        firstSeq,
      )
      // A failed turn produces no text, and staying quiet about it is
      // indistinguishable from being ignored — for the reader in the channel
      // and for whoever is reading the log. Say it in both places.
      if (reason?.kind === 'error') {
        const detail = `${reason.error?.code ?? 'ERROR'}: ${reason.error?.message ?? 'unknown'}`
        process.stderr.write(`[suite-federation] TURN-FAILED ${detail}\n`)
        channel?.push('reply', {
          space_id: spaceId,
          content: `I could not complete that turn — \`${detail}\`.`,
        })
        return
      }
      const body = text.trim()
      process.stderr.write(`[suite-federation] REPLY len=${body.length}\n`)
      if (body) channel?.push('reply', { space_id: spaceId, content: body })
      else channel?.push('typing', { space_id: spaceId, typing: false })

      // `model`, `provider` and `session_key` are the only required columns on
      // agent_usage_events; without a provider report there is nothing true to
      // send, so we stay silent rather than post a zero row.
      if (provider && model) {
        channel?.push('usage_event', {
          space_id: spaceId,
          model,
          provider,
          session_key: String(agent.session.id),
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_tokens: usage.cacheReadTokens,
          cache_write_tokens: usage.cacheWriteTokens,
          total_tokens:
            usage.inputTokens +
            usage.outputTokens +
            usage.cacheReadTokens +
            usage.cacheWriteTokens,
          latency_ms: Date.now() - startedAt,
          metadata: { harness: 'dsh', runtime_id: runtimeId },
        })
      }
    } catch (error) {
      process.stderr.write(
        `[suite-federation] TURN-ERROR ${error?.stack ?? error?.message ?? error}\n`,
      )
      channel?.push('typing', { space_id: spaceId, typing: false })
    } finally {
      inflight.delete(spaceId)
    }
  }

  function join() {
    if (!socket) return
    channel = socket.channel(`runtime:${runtimeId}`, {
      client_info: { client: 'dsh', version: config.version ?? 'dev' },
    })

    channel.on('attention', (payload) => {
      process.stderr.write(`[suite-federation] ATTENTION space=${payload.signal?.space_id} msg=${payload.signal?.message_id}\n`)
      const key = `${payload.signal?.space_id}:${payload.signal?.message_id}`
      if (payload.signal?.message_id) {
        if (seen.has(key)) return
        seen.add(key)
        if (seen.size > 200) seen.delete(seen.values().next().value)
      }
      void handleAttention(payload)
    })

    channel.on('ping', () => {
      channel?.push('pong', { timestamp: new Date().toISOString() })
    })

    channel
      .join()
      .receive('ok', () => process.stderr.write('[suite-federation] JOIN-OK\n'))
      .receive('error', (reason) =>
        process.stderr.write(`[suite-federation] JOIN-REFUSED ${JSON.stringify(reason)}\n`),
      )
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS)
    attempts += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function connect() {
    if (stopped) return
    process.stderr.write(`[suite-federation] connecting to ${url} as ${runtimeId}\n`)
    globalThis.WebSocket = WebSocket
    socket = new Socket(url, {
      params: { runtime_id: runtimeId, token },
      reconnectAfterMs: () => 999999999,
    })
    socket.onOpen(() => {
      process.stderr.write('[suite-federation] SOCKET-OPEN\n')
      attempts = 0
      logger.info?.('socket open')
    })
    socket.onClose(() => {
      if (!stopped) scheduleReconnect()
    })
    socket.onError((err) => process.stderr.write(`[suite-federation] SOCKET-ERROR ${err?.message ?? err}\n`))
    socket.connect()
    join()
  }

  ctx.on('dispose', () => {
    stopped = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    try { channel?.leave() } catch {}
    try { socket?.disconnect() } catch {}
  })

  connect()
}
