import { randomUUID } from 'node:crypto';
import { writeFile, rename, rm } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
/** Preserve the previous complete document while Windows readers release their handles. */
export async function writeEvidence(file: string, contents: string): Promise<void> {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, contents);
  const deadline = Date.now() + 1500;
  try {
    while (true) {
      try {
        await rename(temporary, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          process.platform !== 'win32' ||
          !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') ||
          Date.now() >= deadline
        )
          throw error;
        await pause(15);
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
