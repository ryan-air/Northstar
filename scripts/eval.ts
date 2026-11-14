/**
 * Thin wrapper — prefer `npx vitest run packages/core/src/eval/scenarios.eval.test.ts`
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

async function main() {
  const { startVitest } = await import('vitest/node');
  const vitest = await startVitest(
    'test',
    ['packages/core/src/eval/scenarios.eval.test.ts'],
    {
      watch: false,
      globals: false,
      environment: 'node',
    },
  );
  const ok = vitest?.state.getFiles().every((f) => f.result?.state === 'pass');
  await vitest?.close();
  if (!ok) process.exitCode = 1;
  void require;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
