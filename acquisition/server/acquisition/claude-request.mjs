import { AppError } from '../domain.mjs';

// Only inference is retried. Tool actions are executed separately after a complete response.
export async function claudeRequest(body, env) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(45000), headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': env.ANTHROPIC_API_KEY }, body: JSON.stringify(body) });
      if (!r.ok) {
        if (attempt === 0 && (r.status === 429 || r.status >= 500)) { await r.body?.cancel?.(); continue; }
        throw new AppError(`Claude request failed (${r.status}).`, 502);
      }
      return await r.json();
    } catch (error) {
      if (error instanceof AppError || attempt === 1) throw error;
    }
  }
}
