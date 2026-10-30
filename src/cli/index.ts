import { CliError, parseArgs, parseSubmission, readInput, sendRequest, withSubmissionSource } from './client';

async function main(): Promise<void> {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    const configured = Number(process.env.DIFFEDITOR_TIMEOUT_MS ?? 20000);
    if (!Number.isInteger(configured) || configured < 50 || configured > 120000) {
      throw new CliError('DIFFEDITOR_TIMEOUT_MS must be between 50 and 120000.', 'ARGUMENT_ERROR');
    }
    const request = parsed.request ?? { command: 'submit' as const, payload: withSubmissionSource(parseSubmission(await readInput(parsed.input!, configured))) };
    const result = await sendRequest(request, configured);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    const failure = error as Error & { code?: string; reviewIds?: string[] };
    process.stdout.write(JSON.stringify({ ok: false, error: failure.message || String(error), code: failure.code ?? 'CLI_ERROR', ...(failure.reviewIds ? { reviewIds: failure.reviewIds } : {}) }) + '\n');
    process.exitCode = 1;
  }
}
void main();
