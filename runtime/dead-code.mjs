// Dead Code, Unused Export and Ghost Dependency Eliminator for Agent SDLC Harness.
import fs from 'node:fs';
import path from 'node:path';
import {openIntelligence} from './repo-intelligence.mjs';
import {readJson} from './util.mjs';

const ENTRY_POINT_PATTERNS = [
  /(?:^|\/)cli\.[mc]?js$/,
  /(?:^|\/)index\.[mc]?js$/,
  /(?:^|\/)main\.[mc]?js$/,
  /(?:^|\/)server\.[mc]?js$/,
  /^scripts\//,
  /^evals\//
];

function isKnownEntryPoint(filePath, customEntries = []) {
  const norm = filePath.replace(/\\/g, '/');
  if (customEntries.some(e => norm.endsWith(e))) return true;
  return ENTRY_POINT_PATTERNS.some(p => p.test(norm));
}

/**
 * Extract exported symbols with line numbers from source text.
 */
export function extractExportedSymbols(sourceCode) {
  if (!sourceCode) return [];
  const lines = sourceCode.split('\n');
  const exportsList = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    // export function name(...) or export async function name(...)
    let m = trimmed.match(/^export\s+(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/);
    if (m) {
      exportsList.push({ name: m[1], type: 'function', line: idx + 1 });
      continue;
    }

    // export class Name
    m = trimmed.match(/^export\s+class\s+([a-zA-Z0-9_$]+)/);
    if (m) {
      exportsList.push({ name: m[1], type: 'class', line: idx + 1 });
      continue;
    }

    // export const/let/var a = ...
    m = trimmed.match(/^export\s+(?:const|let|var)\s+([a-zA-Z0-9_$]+)/);
    if (m) {
      exportsList.push({ name: m[1], type: 'variable', line: idx + 1 });
      continue;
    }

    // export default ...
    m = trimmed.match(/^export\s+default\s+/);
    if (m) {
      exportsList.push({ name: 'default', type: 'default', line: idx + 1 });
      continue;
    }

    // export { a, b as c }
    m = trimmed.match(/^export\s+\{([^}]+)\}/);
    if (m) {
      const parts = m[1].split(',');
      for (const p of parts) {
        const item = p.trim();
        if (!item) continue;
        const asMatch = item.match(/^([a-zA-Z0-9_$]+)(?:\s+as\s+([a-zA-Z0-9_$]+))?$/);
        if (asMatch) {
          const exportName = asMatch[2] || asMatch[1];
          exportsList.push({ name: exportName, type: 'named', line: idx + 1 });
        }
      }
    }
  }

  return exportsList;
}

/**
 * Extract imported symbols from source text.
 */
export function extractImportedSymbols(sourceCode) {
  if (!sourceCode) return { namedImports: new Set(), hasWildcard: false };
  const namedImports = new Set();
  let hasWildcard = false;

  const lines = sourceCode.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    // import * as foo from '...'
    if (/import\s+\*\s+as\s+/.test(trimmed)) {
      hasWildcard = true;
    }

    // import { a, b as c } from '...'
    const namedMatch = trimmed.match(/import\s+\{([^}]+)\}\s+from/);
    if (namedMatch) {
      const parts = namedMatch[1].split(',');
      for (const p of parts) {
        const item = p.trim();
        if (!item) continue;
        const sub = item.match(/^([a-zA-Z0-9_$]+)/);
        if (sub) namedImports.add(sub[1]);
      }
    }

    // import foo from '...' (default import)
    const defaultMatch = trimmed.match(/import\s+([a-zA-Z0-9_$]+)\s+from/);
    if (defaultMatch && !trimmed.startsWith('import {') && !trimmed.startsWith('import *')) {
      namedImports.add('default');
    }

    // const { a, b } = require(...)
    const cjsDestruct = trimmed.match(/(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\(/);
    if (cjsDestruct) {
      const parts = cjsDestruct[1].split(',');
      for (const p of parts) {
        const item = p.trim();
        if (!item) continue;
        const sub = item.match(/^([a-zA-Z0-9_$]+)/);
        if (sub) namedImports.add(sub[1]);
      }
    }
  }

  return { namedImports, hasWildcard };
}

const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.rb', '.php', '.cs']);

function isCodeFile(filePath) {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Scan repository for unreachable files, unused exports, and ghost dependencies.
 */
export function findDeadCode(projectRoot, { openIntel = null, entryPoints = [] } = {}) {
  const intel = openIntel || openIntelligence(projectRoot);
  const graph = intel.graph;

  const unreachableFiles = [];
  const allUsedSymbols = new Set();
  let hasGlobalWildcard = false;

  // First pass: collect all imported symbols across all files in the project
  for (const [filePath] of graph.files) {
    if (!isCodeFile(filePath)) continue;
    try {
      const fullPath = path.resolve(projectRoot, filePath);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        const { namedImports, hasWildcard } = extractImportedSymbols(content);
        if (hasWildcard) hasGlobalWildcard = true;
        for (const sym of namedImports) {
          allUsedSymbols.add(sym);
        }
      }
    } catch {}
  }

  const unusedExports = [];
  let totalExportsCount = 0;

  for (const [filePath, file] of graph.files) {
    if (file.is_test || !isCodeFile(filePath)) continue;
    const isEntry = isKnownEntryPoint(filePath, entryPoints);

    const incoming = graph.dependents.get(filePath);
    const isUnreachable = (!incoming || incoming.size === 0) && !isEntry;

    if (isUnreachable) {
      unreachableFiles.push({
        path: filePath,
        module: file.module || null,
        exports_count: (file.exports || []).length
      });
    }

    // Scan exports of non-entry, reachable files
    if (!isEntry) {
      try {
        const fullPath = path.resolve(projectRoot, filePath);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const fileExports = extractExportedSymbols(content);
          totalExportsCount += fileExports.length;

          for (const exp of fileExports) {
            // If symbol is never imported anywhere and no wildcard import was used
            if (!hasGlobalWildcard && !allUsedSymbols.has(exp.name)) {
              unusedExports.push({
                file: filePath,
                name: exp.name,
                type: exp.type,
                line: exp.line
              });
            }
          }
        }
      } catch {}
    }
  }

  // Ghost dependencies detection in package.json
  const ghostDependencies = [];
  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = readJson(pkgPath, {});
    const declaredDeps = Object.keys(pkg.dependencies || {});
    const usedExternals = new Set(graph.external_dependencies || []);

    for (const dep of declaredDeps) {
      if (!usedExternals.has(dep)) {
        ghostDependencies.push({
          name: dep,
          version: pkg.dependencies[dep],
          type: 'production'
        });
      }
    }
  }

  const totalFiles = graph.file_count || 1;
  const deadCount = unreachableFiles.length;
  const usedExportsCount = Math.max(0, totalExportsCount - unusedExports.length);
  const exportUtilizationRate = totalExportsCount > 0
    ? Number(((usedExportsCount / totalExportsCount) * 100).toFixed(1))
    : 100.0;

  const healthScore = Math.max(0, Math.round(
    100 - (deadCount / totalFiles * 40)
        - (unusedExports.length * 2)
        - (ghostDependencies.length * 5)
  ));

  return {
    schema: 'agent-sdlc/dead-code-report/v1',
    health_score: healthScore,
    total_files: totalFiles,
    unreachable_files_count: unreachableFiles.length,
    unreachable_files: unreachableFiles,
    total_exports_count: totalExportsCount,
    unused_exports_count: unusedExports.length,
    unused_exports: unusedExports,
    export_utilization_rate: exportUtilizationRate,
    ghost_dependencies_count: ghostDependencies.length,
    ghost_dependencies: ghostDependencies
  };
}
