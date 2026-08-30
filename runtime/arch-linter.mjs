// Architectural Linter and Module Boundary Enforcer for Agent SDLC Harness.
import {openIntelligence} from './repo-intelligence.mjs';

const norm = p => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Find all circular dependency cycles in the repository import graph.
 */
export function findCircularDependencies(graph) {
  const adj = new Map();
  for (const [p] of graph.files) adj.set(p, new Set());
  for (const e of graph.edges) {
    if (e.from && e.to && e.from !== e.to) {
      if (!adj.has(e.from)) adj.set(e.from, new Set());
      adj.get(e.from).add(e.to);
    }
  }

  const visited = new Map(); // 0: unvisited, 1: visiting, 2: visited
  const stack = [];
  const foundCycles = [];
  const cycleSignatures = new Set();

  function dfs(node) {
    visited.set(node, 1);
    stack.push(node);

    for (const neighbor of adj.get(node) || []) {
      const state = visited.get(neighbor) || 0;
      if (state === 1) {
        // Cycle detected: extract cycle slice from stack
        const cycleStartIndex = stack.indexOf(neighbor);
        if (cycleStartIndex !== -1) {
          const cycle = stack.slice(cycleStartIndex);
          // Normalize rotation to avoid duplicate cycle representations
          const minIdx = cycle.reduce((min, cur, idx) => cur < cycle[min] ? idx : min, 0);
          const normalized = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
          const signature = normalized.join(' -> ');
          if (!cycleSignatures.has(signature)) {
            cycleSignatures.add(signature);
            foundCycles.push(normalized);
          }
        }
      } else if (state === 0) {
        dfs(neighbor);
      }
    }

    stack.pop();
    visited.set(node, 2);
  }

  for (const [node] of adj) {
    if ((visited.get(node) || 0) === 0) {
      dfs(node);
    }
  }

  return {
    cycles: foundCycles,
    cycle_count: foundCycles.length
  };
}

/**
 * Check module boundary rules and layering constraints.
 */
export function checkModuleBoundaries(graph, { rules = [] } = {}) {
  const violations = [];
  for (const e of graph.edges) {
    const fromFile = graph.files.get(e.from);
    const toFile = graph.files.get(e.to);
    if (!fromFile || !toFile) continue;

    // Cross-module import check
    if (fromFile.module && toFile.module && fromFile.module !== toFile.module) {
      // Check if importing test file from non-test file
      if (toFile.is_test && !fromFile.is_test) {
        violations.push({
          type: 'PRODUCTION_IMPORTS_TEST',
          from: e.from,
          to: e.to,
          reason: `Production file "${e.from}" imports test file "${e.to}"`
        });
      }
    }
  }

  return {
    violations,
    violation_count: violations.length
  };
}

/**
 * Enforce strict hierarchy across architectural layers (e.g. ['domain', 'runtime', 'adapters', 'cli']).
 * Rule: lower layers cannot import higher layers.
 */
export function enforceLayerConstraints(graph, { layerOrder = [] } = {}) {
  if (!Array.isArray(layerOrder) || layerOrder.length === 0) {
    return { violations: [], violation_count: 0 };
  }

  const violations = [];
  const getLayer = (filePath) => {
    const p = norm(filePath);
    for (let i = 0; i < layerOrder.length; i++) {
      const layer = layerOrder[i];
      if (p.startsWith(`${layer}/`) || p.startsWith(`src/${layer}/`) || p === layer) {
        return { name: layer, index: i };
      }
    }
    return null;
  };

  for (const e of graph.edges) {
    const fromLayer = getLayer(e.from);
    const toLayer = getLayer(e.to);

    if (fromLayer && toLayer && fromLayer.name !== toLayer.name) {
      // Lower layer importing higher layer is forbidden
      if (fromLayer.index < toLayer.index) {
        violations.push({
          type: 'LAYER_INVERSION',
          from: e.from,
          to: e.to,
          from_layer: fromLayer.name,
          to_layer: toLayer.name,
          reason: `Layer inversion: Lower layer "${fromLayer.name}" cannot import higher layer "${toLayer.name}"`
        });
      }
    }
  }

  return {
    violations,
    violation_count: violations.length
  };
}

/**
 * Check for forbidden dependency edges defined by rules.
 */
export function checkForbiddenImports(graph, { forbiddenRules = [] } = {}) {
  if (!Array.isArray(forbiddenRules) || forbiddenRules.length === 0) {
    return { violations: [], violation_count: 0 };
  }

  const violations = [];
  for (const e of graph.edges) {
    const fromNorm = norm(e.from);
    const toNorm = norm(e.to);

    for (const rule of forbiddenRules) {
      const fromMatch = !rule.from || fromNorm.includes(rule.from);
      const toMatch = !rule.to || toNorm.includes(rule.to);

      if (fromMatch && toMatch) {
        violations.push({
          type: 'FORBIDDEN_IMPORT',
          from: e.from,
          to: e.to,
          reason: rule.reason || `Import from "${e.from}" to "${e.to}" is strictly forbidden by policy`
        });
      }
    }
  }

  return {
    violations,
    violation_count: violations.length
  };
}

/**
 * Perform a full architectural governance audit on the repository.
 */
export function auditArchitecture(projectRoot, {
  strict = false,
  layerOrder = [],
  forbiddenRules = [],
  openIntel = null
} = {}) {
  const intel = openIntel || openIntelligence(projectRoot);
  const circ = findCircularDependencies(intel.graph);
  const bounds = checkModuleBoundaries(intel.graph);
  const layers = enforceLayerConstraints(intel.graph, { layerOrder });
  const forbidden = checkForbiddenImports(intel.graph, { forbiddenRules });

  const allViolations = [
    ...bounds.violations,
    ...layers.violations,
    ...forbidden.violations
  ];

  const totalIssues = circ.cycle_count + allViolations.length;
  const status = totalIssues === 0 ? 'PASS' : (strict ? 'FAIL' : 'WARN');

  return {
    schema: 'agent-sdlc/arch-audit/v1',
    status,
    file_count: intel.graph.file_count,
    edge_count: intel.graph.edge_count,
    circular_dependencies: circ.cycles,
    circular_dependency_count: circ.cycle_count,
    boundary_violations: allViolations,
    boundary_violation_count: allViolations.length,
    layer_violations_count: layers.violation_count,
    forbidden_imports_count: forbidden.violation_count,
    total_issues: totalIssues
  };
}
