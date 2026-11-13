import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The checked documents: the root README and CONTRIBUTING, and the Markdown files directly in
 * `docs/` and `docs/history/`. Subdirectories such as `docs/architecture-remediation/` and
 * `docs/evidence/` are not scanned themselves, but a link into them from a checked document must
 * still resolve.
 */
async function checkedDocuments(root: string): Promise<string[]> {
  const markdown = async (directory: string) =>
    (await readdir(path.join(root, directory), { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.posix.join(directory, entry.name))
      .sort();
  const top: string[] = [];
  for (const name of ['README.md', 'CONTRIBUTING.md']) if (await exists(root, name)) top.push(name);
  return [...top, ...(await markdown('docs')), ...(await markdown('docs/history'))];
}

const exists = (root: string, relative: string) =>
  stat(path.join(root, relative)).then(
    () => true,
    () => false,
  );

/** Code blocks and code spans hold examples, not links. Line breaks are kept for line numbers. */
function withoutCode(markdown: string): string {
  const blank = (text: string) => text.replace(/[^\n]/gu, ' ');
  return markdown
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gmu, blank)
    .replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu, blank);
}

/** Inline links and images `[text](target "title")`, and reference definitions `[id]: target`. */
function linkTargets(markdown: string): { target: string; line: number }[] {
  const text = withoutCode(markdown);
  const found: { target: string; line: number }[] = [];
  const line = (index: number) => text.slice(0, index).split('\n').length;
  for (const match of text.matchAll(/\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/gu))
    found.push({ target: match[1]!.replace(/^<|>$/gu, ''), line: line(match.index) });
  for (const match of text.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]*>|\S+)/gmu))
    found.push({ target: match[1]!.replace(/^<|>$/gu, ''), line: line(match.index) });
  return found;
}

/** External links (with a scheme or protocol-relative) and pure anchors are not checked. */
const external = (target: string) => /^[a-z][a-z0-9+.-]*:|^\/\//iu.test(target);

/**
 * `plan/` is the separately cloned planning repository. It is git-ignored, so it is absent from a
 * fresh checkout, and links into it are not checked.
 */
const OUTSIDE_REPOSITORY = ['plan/'];

/** Every relative link in `files` whose file part does not exist, as `file:line -> target`. */
async function brokenLinks(root: string, files: readonly string[]): Promise<string[]> {
  const broken: string[] = [];
  for (const file of files) {
    const markdown = await readFile(path.join(root, file), 'utf8');
    for (const { target, line } of linkTargets(markdown)) {
      if (external(target) || target.startsWith('#')) continue;
      const filePart = decodeURI(target.replace(/[?#].*$/su, ''));
      const resolved = filePart.startsWith('/')
        ? filePart.slice(1)
        : path.posix.join(path.posix.dirname(file), filePart);
      if (OUTSIDE_REPOSITORY.some((prefix) => resolved.startsWith(prefix))) continue;
      if (!(await exists(root, resolved))) broken.push(`${file}:${line} -> ${target}`);
    }
  }
  return broken;
}

void test('every relative link in README, CONTRIBUTING, docs/ and docs/history/ resolves', async () => {
  const files = await checkedDocuments(repository);
  assert.ok(files.includes('README.md') && files.includes('CONTRIBUTING.md'));
  assert.ok(files.includes('docs/README.md') && files.some((f) => f.startsWith('docs/history/')));
  const broken = await brokenLinks(repository, files);
  assert.deepEqual(broken, [], `Broken relative links:\n${broken.join('\n')}`);
});

void test('docs/README.md lists every Markdown file in docs/ and docs/history/ exactly once', async () => {
  const index = await readFile(path.join(repository, 'docs/README.md'), 'utf8');
  const listed = linkTargets(index)
    .map(({ target }) => target.replace(/[?#].*$/su, ''))
    .filter((target) => !external(target) && target.endsWith('.md'))
    .map((target) => path.posix.join('docs', target));
  assert.ok(listed.includes('docs/architecture-remediation/README.md'));
  const documents = (await checkedDocuments(repository)).filter(
    (file) => file.startsWith('docs/') && file !== 'docs/README.md',
  );
  const indexed = listed.filter((target) => /^docs\/(?:history\/)?[^/]+\.md$/u.test(target));
  // Sorted equality fails on a missing document, a duplicate line, or a listed non-document.
  assert.deepEqual([...indexed].sort(), [...documents].sort());
});

void test('the link check reports a broken link, resolves anchors, and ignores external links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bve-markdown-links-'));
  try {
    await mkdir(path.join(root, 'docs/history'), { recursive: true });
    await writeFile(path.join(root, 'docs/present.md'), '# Present\n\n## Section\n');
    await writeFile(
      path.join(root, 'docs/history/old.md'),
      [
        '# Old',
        '',
        'See [present](../present.md#section), [self](#old) and [web](https://example.com/x.md).',
        'Mail [someone](mailto:someone@example.com).',
        '```md',
        '[in code](missing-in-code.md)',
        '```',
        'Inline `[code](missing-inline.md)` is not a link.',
        'This [one](../missing.md#anchor) is broken; [plan](../../plan/absent.md) is not checked.',
        '',
        '[ref]: ../present.md',
      ].join('\n'),
    );
    await writeFile(path.join(root, 'README.md'), '[docs](docs/present.md)\n');
    const files = await checkedDocuments(root);
    assert.deepEqual(files, ['README.md', 'docs/present.md', 'docs/history/old.md']);
    assert.deepEqual(await brokenLinks(root, files), [
      'docs/history/old.md:9 -> ../missing.md#anchor',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
