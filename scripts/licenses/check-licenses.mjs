import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'licenses/manifest.json'), 'utf8'));
const policy = JSON.parse(fs.readFileSync(path.join(root, 'licenses/policy.json'), 'utf8'));
const blocked = new RegExp(`\\b(?:${policy.blockedPatterns.join('|')})\\b`, 'i');
const review = new Set(policy.reviewLicenses);
const exceptions = new Set(policy.exceptions.map(item => `${item.project}|${item.package}`));
const failures = [];
const reviews = [];

for (const project of manifest.projects) {
  const report = JSON.parse(fs.readFileSync(path.join(root, `licenses/${project.project}.json`), 'utf8'));
  for (const dependency of report.dependencies) {
    const key = `${project.project}|${dependency.name}`;
    if ((blocked.test(dependency.license) || dependency.license === 'Unknown') && !exceptions.has(key)) {
      failures.push(`${key}: ${dependency.license}`);
    }
    if (review.has(dependency.license) && !exceptions.has(key)) {
      reviews.push(`${key}: ${dependency.license}`);
    }
  }
  for (const missing of report.missingDirectDependencies ?? []) {
    failures.push(`${project.project}|${missing}: missing from current environment`);
  }
}

if (reviews.length) {
  console.warn('License review items:');
  for (const item of reviews) console.warn(`- ${item}`);
}
if (failures.length) {
  console.error('License policy failures:');
  for (const item of failures) console.error(`- ${item}`);
  process.exitCode = 1;
} else {
  console.log(`License policy passed; ${reviews.length} item(s) require review.`);
}
