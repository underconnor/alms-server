import { createInterface } from 'node:readline';
import { createPlaybackLogProjection } from '../src/playback-log-projection.ts';

// Log bytes stay in stdin and memory; only the fixed projection is written to stdout.
const args = process.argv.slice(2);
try {
  if (args.length !== 6 || args[0] !== '--source' || args[2] !== '--from' || args[4] !== '--until') throw new Error();
  const projection = createPlaybackLogProjection(args[1], { from: args[3], until: args[5] });
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) projection.push(line);
  process.stdout.write(JSON.stringify(projection.result(), null, 2) + '\n');
} catch {
  process.stderr.write('PLAYBACK_LOG_INPUT_INVALID: use --source api|worker --from UTC --until UTC with a window of at most 24 hours.\n');
  process.exitCode = 1;
}
