/**
 * Commit message validator adhering to Chris Beams' style:
 * https://cbea.ms/git-commit/
 *
 * Rules enforced:
 * 1. Separate subject from body with a blank line
 * 2. Limit the subject line to 50 characters (hard limit 72)
 * 3. Capitalize the subject line
 * 4. Do not end the subject line with a period
 * 5. Use the imperative mood in the subject line
 * 6. Wrap the body at 72 characters
 * 7. Do NOT use Conventional Commits prefixes (feat:, fix:, chore:, etc.)
 */

import fs from 'node:fs';

const commitFile = process.argv[2];
if (!commitFile) {
  console.error('Usage: node build/check-commit-msg.js <commit-message-file>');
  process.exit(1);
}

const raw = fs.readFileSync(commitFile, 'utf8');

// Strip git comment lines
const lines = raw
  .split('\n')
  .map((line) => line.trimEnd())
  .filter((line) => !line.startsWith('#'));

// Trim trailing empty lines
while (lines.length > 0 && lines[lines.length - 1] === '') {
  lines.pop();
}

if (lines.length === 0) {
  process.exit(0);
}

const subject = lines[0].trim();
const body = lines.slice(1);

// Exempt default Git merge commits and revert commits
if (subject.startsWith('Merge ') || subject.startsWith('Revert ')) {
  process.exit(0);
}

const errors = [];

// Explicitly reject Conventional Commits (e.g. feat:, fix:, chore:, feat(scope):)
const conventionalPattern = /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(\([^)]+\))?:\s*/i;
if (conventionalPattern.test(subject)) {
  errors.push(
    'Do not use Conventional Commits prefixes ("feat:", "fix:", etc.). Use plain, capitalized imperative verbs ("Add...", "Fix...").',
  );
}

// Rule 1: Separate subject from body with a blank line
if (body.length > 0 && body[0] !== '') {
  errors.push('Rule 1: Separate subject from body with a blank line.');
}

// Rule 2: Limit the subject line to 50 characters (hard error at 72)
if (subject.length > 72) {
  errors.push(
    `Rule 2: Subject line exceeds hard limit of 72 characters (${subject.length} chars). Aim for <= 50 characters.`,
  );
} else if (subject.length > 50) {
  console.warn(
    `[commit-msg warning] Subject line is ${subject.length} chars (guideline is <= 50 chars: https://cbea.ms/git-commit/#limit-50).`,
  );
}

// Rule 3: Capitalize the subject line
const firstLetterMatch = subject.match(/[a-zA-Z]/);
if (firstLetterMatch && firstLetterMatch[0] !== firstLetterMatch[0].toUpperCase()) {
  errors.push(`Rule 3: Capitalize the subject line ("${subject}").`);
}

// Rule 4: Do not end the subject line with a period
if (subject.endsWith('.')) {
  errors.push('Rule 4: Do not end the subject line with a period.');
}

// Rule 5: Use the imperative mood in the subject line
const nonImperative = /^(added|adding|fixed|fixing|updated|updating|changed|changing|removed|removing|created|creating|deleted|deleting|refactored|refactoring)\b/i;
const verbMatch = subject.match(nonImperative);
if (verbMatch) {
  errors.push(`Rule 5: Use imperative mood (e.g. use "Add" instead of "${verbMatch[0]}").`);
}

// Rule 6: Wrap the body at 72 characters
body.forEach((line, idx) => {
  // Allow long URLs, Markdown links, and indented code/list items
  const isUrlOrLink = line.includes('http://') || line.includes('https://') || line.includes('file://');
  const isIndented = line.startsWith('    ') || line.startsWith('\t');
  if (line.length > 72 && !isUrlOrLink && !isIndented) {
    errors.push(`Rule 6: Wrap body line ${idx + 2} at 72 characters (currently ${line.length} chars).`);
  }
});

if (errors.length > 0) {
  console.error('\n❌ Commit message rejected. Follow https://cbea.ms/git-commit/ conventions:');
  console.error('The Seven Rules of a Great Git Commit Message:');
  console.error('  1. Separate subject from body with a blank line');
  console.error('  2. Limit the subject line to 50 characters');
  console.error('  3. Capitalize the subject line');
  console.error('  4. Do not end the subject line with a period');
  console.error('  5. Use the imperative mood in the subject line');
  console.error('  6. Wrap the body at 72 characters');
  console.error('  7. Use the body to explain what and why vs. how\n');
  console.error('Issues found:');
  for (const err of errors) console.error(`  - ${err}`);
  console.error(`\nSubject was: "${subject}"\n`);
  process.exit(1);
}
