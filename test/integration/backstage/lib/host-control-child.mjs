import { openEvidence } from './evidence.mjs';
const [file, fault] = process.argv.slice(2);
if (fault === 'missing-report') process.exit(0);
const evidence = await openEvidence(file, []);
await evidence.run('driver.case', 'execution', async () => {
  if (fault === 'failed-child') process.exit(23);
  if (fault === 'interrupted-child') {
    process.kill(process.pid, 'SIGTERM');
    await new Promise(() => {});
  }
});
if (fault !== 'unfinished-report')
  await evidence.run('following.case', 'execution', async () => {});
