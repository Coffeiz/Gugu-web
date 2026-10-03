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

function parseLicenseExpression(expression) {
  const tokens = expression.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9][A-Za-z0-9.+-]*/gi) ?? [];
  let index = 0;

  function primary() {
    if (tokens[index] === '(') {
      index += 1;
      const value = parseOr();
      if (tokens[index] !== ')') throw new Error('未闭合的括号');
      index += 1;
      return value;
    }
    const license = tokens[index++];
    if (!license || /^(AND|OR|WITH)$/i.test(license)) throw new Error('缺少许可证标识');
    if (/^WITH$/i.test(tokens[index] ?? '')) {
      index += 1;
      const exception = tokens[index++];
      if (!exception || /^(AND|OR|WITH)$/i.test(exception)) throw new Error('缺少许可证例外标识');
      return { type: 'with', license, exception };
    }
    return { type: 'license', license };
  }

  function parseAnd() {
    let value = primary();
    while (/^AND$/i.test(tokens[index] ?? '')) {
      index += 1;
      value = { type: 'and', left: value, right: primary() };
    }
    return value;
  }

  function parseOr() {
    let value = parseAnd();
    while (/^OR$/i.test(tokens[index] ?? '')) {
      index += 1;
      value = { type: 'or', left: value, right: parseAnd() };
    }
    return value;
  }

  const tree = parseOr();
  if (!tokens.length || index !== tokens.length) throw new Error('许可证表达式格式无效');
  return tree;
}

function hasBlockedLicense(expression) {
  let tree;
  try {
    tree = parseLicenseExpression(expression);
  } catch {
    // 表达式无法解析时保守处理：仍然检查原文是否含受限许可证。
    return expression === 'Unknown' || blocked.test(expression);
  }

  const isAllowed = node => {
    if (node.type === 'license') return node.license !== 'Unknown' && !blocked.test(node.license);
    if (node.type === 'with') return node.license !== 'Unknown' && !blocked.test(node.license);
    if (node.type === 'and') return isAllowed(node.left) && isAllowed(node.right);
    return isAllowed(node.left) || isAllowed(node.right);
  };
  return !isAllowed(tree);
}

for (const project of manifest.projects) {
  const report = JSON.parse(fs.readFileSync(path.join(root, `licenses/${project.project}.json`), 'utf8'));
  for (const dependency of report.dependencies) {
    const key = `${project.project}|${dependency.name}`;
    if (hasBlockedLicense(dependency.license) && !exceptions.has(key)) {
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
