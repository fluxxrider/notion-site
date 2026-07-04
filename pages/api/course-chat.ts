import { NextApiRequest, NextApiResponse } from 'next'

import { SupabaseClient, createClient } from '@supabase/supabase-js'
import got from 'got'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Max chat requests per user per rolling hour. */
const CHAT_REQUESTS_PER_HOUR = 20
const RATE_WINDOW_MS = 60 * 60 * 1000

const MODEL = 'gpt-4o-mini'

/** USD per token. Keep in sync with the provider's price sheet. */
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.6 / 1_000_000 }
}

// ---------------------------------------------------------------------------

type Role = 'system' | 'user' | 'assistant'

interface ChatMessage {
  role: Role
  content: string
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

/**
 * Service-role client for usage reads/writes (bypasses RLS — chat_usage has
 * no public policies). Server-only: never import this route's helpers from
 * client code.
 */
function getAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

/**
 * Verify the caller's Supabase JWT server-side. Nothing from the request
 * body is trusted — only the Authorization bearer token, validated against
 * Supabase Auth (signature + expiry).
 */
async function getAuthedUserId(req: NextApiRequest): Promise<string | null> {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return null

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null

  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data?.user?.id) return null
  return data.user.id
}

function startOfUtcDay(): Date {
  const now = new Date()
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  )
}

function secondsUntilNextUtcDay(): number {
  const next = startOfUtcDay().getTime() + 24 * 60 * 60 * 1000
  return Math.max(1, Math.ceil((next - Date.now()) / 1000))
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Fail closed: without the service key we can't rate-limit or track spend,
  // and an unlimited endpoint is exactly the incident we're preventing.
  const admin = getAdminClient()
  if (!admin) {
    return res
      .status(503)
      .json({ error: 'Chat is not configured on this deployment.' })
  }

  // 1) Auth gate ------------------------------------------------------------
  const userId = await getAuthedUserId(req)
  if (!userId) {
    return res.status(401).json({ error: 'Sign in to use course chat.' })
  }

  // 2) Global daily spend ceiling -------------------------------------------
  // DAILY_TOKEN_BUDGET = max total tokens (input + output) per UTC day across
  // all users. Unset or 0 disables the ceiling.
  const dailyBudget = Number(process.env.DAILY_TOKEN_BUDGET || 0)
  if (dailyBudget > 0) {
    const { data: todayRows, error: budgetErr } = await admin
      .from('chat_usage')
      .select('input_tokens, output_tokens')
      .gte('created_at', startOfUtcDay().toISOString())
    if (budgetErr) {
      return res.status(503).json({ error: 'Chat is unavailable right now.' })
    }
    const spentTokens = (todayRows || []).reduce(
      (s, r) => s + (r.input_tokens || 0) + (r.output_tokens || 0),
      0
    )
    if (spentTokens >= dailyBudget) {
      res.setHeader('Retry-After', String(secondsUntilNextUtcDay()))
      return res.status(503).json({
        error: 'Course chat is resting for today — try again tomorrow.'
      })
    }
  }

  // 3) Per-user rate limit (windowed count over chat_usage) ------------------
  const windowStart = new Date(Date.now() - RATE_WINDOW_MS)
  const { data: windowRows, error: rateErr } = await admin
    .from('chat_usage')
    .select('created_at')
    .eq('user_id', userId)
    .gte('created_at', windowStart.toISOString())
    .order('created_at', { ascending: true })
  if (rateErr) {
    return res.status(503).json({ error: 'Chat is unavailable right now.' })
  }
  if ((windowRows || []).length >= CHAT_REQUESTS_PER_HOUR) {
    const oldest = new Date(windowRows[0].created_at).getTime()
    const retryAfterSec = Math.max(
      1,
      Math.ceil((oldest + RATE_WINDOW_MS - Date.now()) / 1000)
    )
    res.setHeader('Retry-After', String(retryAfterSec))
    return res.status(429).json({
      error: `You’ve hit the chat limit (${CHAT_REQUESTS_PER_HOUR}/hour). Try again in a bit.`
    })
  }

  // Log the request up front (tokens 0) so in-flight and failed requests
  // still count against the window — closes the burst race between the count
  // above and the insert, and stops error-retry hammering.
  const { data: usageRow } = await admin
    .from('chat_usage')
    .insert({ user_id: userId, model: MODEL })
    .select('id')
    .single()

  // 4) Validate input --------------------------------------------------------
  const {
    messages,
    courseTitle,
    courseDescription
  }: {
    messages?: ChatMessage[]
    courseTitle?: string
    courseDescription?: string
  } = req.body || {}

  const sanitizedMessages = (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({
      role: m.role,
      content: String(m.content || '').slice(0, 6000)
    }))
    .filter((m) => Boolean(m.content.trim()))
    .slice(-20)

  if (sanitizedMessages.length === 0) {
    return res.status(400).json({ error: 'At least one message is required' })
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing OPENAI_API_KEY' })
  }

  const systemPrompt = [
    'You are a course assistant chatbot.',
    `Course name: ${courseTitle || 'Untitled course'}`,
    `Course description: ${courseDescription || 'No description provided.'}`,
    'Your job is to answer student questions about this course topic.',
    'If a question is unrelated to the course topic, politely say so and suggest what kinds of questions you can answer.'
  ].join('\n')

  const requestMessages: ChatMessage[] = [
    {
      role: 'system',
      content: systemPrompt
    },
    ...sanitizedMessages
  ]

  try {
    const completion = await got
      .post('https://api.openai.com/v1/chat/completions', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        json: {
          model: MODEL,
          temperature: 0.3,
          messages: requestMessages
        }
      })
      .json<OpenAIChatResponse>()

    // 5) Token tracking: record real usage + estimated cost. Best-effort —
    // a logging failure shouldn't eat the user's reply.
    const inputTokens = completion?.usage?.prompt_tokens ?? 0
    const outputTokens = completion?.usage?.completion_tokens ?? 0
    const price = MODEL_PRICES[MODEL]
    const estimatedCost = price
      ? inputTokens * price.input + outputTokens * price.output
      : 0
    if (usageRow?.id) {
      await admin
        .from('chat_usage')
        .update({
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          estimated_cost_usd: estimatedCost.toFixed(6)
        })
        .eq('id', usageRow.id)
    }

    const reply = completion?.choices?.[0]?.message?.content?.trim()
    if (!reply) {
      return res.status(502).json({ error: 'No response from chat model' })
    }

    return res.status(200).json({ reply })
  } catch (error: unknown) {
    const err = error as {
      message?: string
      response?: {
        statusCode?: number
      }
    }
    const statusCode = Number(err?.response?.statusCode || 500)
    const message = err?.message || 'Could not generate chat response'
    return res.status(statusCode).json({ error: message })
  }
}
