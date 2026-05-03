/**
 * Anthropic streaming via raw fetch — works on both localhost (direct) and
 * Vercel (through the /api/anthropic/:path* proxy rewrite in vercel.json).
 *
 * We bypass the @anthropic-ai/sdk for streaming so we can control the exact
 * URL and avoid SDK URL-construction quirks when running behind a proxy.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig, ChatMessage } from '../types';
import { isOpenAICompatible, streamMessageOpenAI } from './openai-compatible';

// Re-export for convenience
export { isOpenAICompatible } from './openai-compatible';

export interface StreamHandlers {
  onDelta: (textDelta: string) => void;
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
}

function isLocalhost(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1')
  );
}

/** Resolve the base URL to use for Anthropic API calls. */
function resolveAnthropicBase(cfg: AppConfig): string {
  // Custom non-Anthropic base URL (e.g. MiMo, Bedrock) — use as-is.
  if (cfg.baseUrl && !cfg.baseUrl.includes('api.anthropic.com')) {
    return cfg.baseUrl.replace(/\/$/, '');
  }
  // On localhost call Anthropic directly; elsewhere go through Vercel proxy
  // rewrite  /api/anthropic/:path* → https://api.anthropic.com/:path*
  return isLocalhost()
    ? 'https://api.anthropic.com'
    : `${window.location.origin}/api/anthropic`;
}

// Keep makeClient exported for any callers that still use it (e.g. design-system preview).
export function makeClient(cfg: AppConfig): Anthropic {
  return new Anthropic({
    apiKey: cfg.apiKey,
    baseURL: resolveAnthropicBase(cfg),
    dangerouslyAllowBrowser: true,
  });
}

export async function streamMessage(
  cfg: AppConfig,
  system: string,
  history: ChatMessage[],
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  // Route to OpenAI-compatible provider for non-Anthropic models.
  if (isOpenAICompatible(cfg.model, cfg.baseUrl)) {
    return streamMessageOpenAI(cfg, system, history, signal, handlers);
  }

  if (!cfg.apiKey) {
    handlers.onError(new Error('Missing API key — open Settings and paste one in.'));
    return;
  }

  const base = resolveAnthropicBase(cfg);
  const endpoint = `${base}/v1/messages`;
  let acc = '';

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 8192,
        stream: true,
        system,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
      }),
      signal,
    });

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      handlers.onError(new Error(`API error ${resp.status}: ${text || 'no body'}`));
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        if (!frame.startsWith('data: ')) continue;
        const dataStr = frame.slice(6).trim();
        if (dataStr === '[DONE]') continue;

        try {
          const data = JSON.parse(dataStr) as {
            type: string;
            delta?: { type: string; text: string };
            error?: { message: string };
          };

          if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
            const text = data.delta.text ?? '';
            if (text) { acc += text; handlers.onDelta(text); }
          } else if (data.type === 'message_stop') {
            handlers.onDone(acc);
            return;
          } else if (data.type === 'error') {
            handlers.onError(new Error(data.error?.message ?? 'API error'));
            return;
          }
        } catch { /* ignore malformed SSE frames */ }
      }
    }

    handlers.onDone(acc);
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    handlers.onError(err instanceof Error ? err : new Error(String(err)));
  }
}
