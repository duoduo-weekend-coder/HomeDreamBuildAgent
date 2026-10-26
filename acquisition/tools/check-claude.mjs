// Read-only connectivity/authentication check. Never prints credentials or request headers.
const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error('ANTHROPIC_API_KEY is missing from .env.');
  process.exitCode = 1;
} else {
  try {
    const response = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(15000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Provider error messages may contain submitted values; only print status/type.
      console.error(`Anthropic authentication/model lookup failed: HTTP ${response.status}, ${body.error?.type || 'unknown_error'}.`);
      process.exitCode = 1;
    } else {
      console.log('Anthropic accepted the credential. No generation request was made.');
      for (const model of body.data || []) console.log(`${model.id} — ${model.display_name || ''}`);
      if (body.has_more) console.log('Additional models exist beyond this first page.');
      const selected = process.env.ANTHROPIC_MODEL;
      console.log(selected ? `Configured model: ${selected}` : 'Next: set ANTHROPIC_MODEL in .env to an available model ID.');
      console.log('A models-list response does not verify credit balance or a generation request.');
    }
  } catch (error) {
    const code = String(error.cause?.code || error.code || error.name || 'NETWORK_ERROR').replace(/[^A-Z_a-z0-9]/g, '').slice(0,60);
    console.error(`Verification could not run: network/DNS request failed (${code}). Run this check from a terminal with internet access.`);
    process.exitCode = 1;
  }
}
