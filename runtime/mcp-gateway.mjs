// MCP Tool Gateway Bridge for Agent SDLC Harness.
// Exposes extended harness operations as standardized MCP Tools.

import {renderTuiDashboard} from './tui.mjs';
import {evaluateBudgetCircuitBreaker} from './governor.mjs';
import {lookupFailurePattern} from './learning.mjs';
import {detectFlakyTests} from './flaky-detector.mjs';
import {generatePrBody,generateSemanticReleaseNotes} from './pr-generator.mjs';
import {loadRun,listTasks} from './store.mjs';

export const GATEWAY_TOOLS = [
  {
    name: 'agent_sdlc_dashboard',
    description: 'Render terminal or JSON dashboard state for a run.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['tui', 'json'] }
      }
    }
  },
  {
    name: 'agent_sdlc_govern',
    description: 'Evaluate budget circuit breaker and risk governance for a run.',
    inputSchema: {
      type: 'object',
      required: ['run_id'],
      properties: {
        run_id: { type: 'string' },
        max_cost_usd: { type: 'number' },
        max_tokens: { type: 'number' }
      }
    }
  },
  {
    name: 'agent_sdlc_flaky_detect',
    description: 'Detect whether a test command is flaky through jittered executions.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'array', items: { type: 'string' } },
        iterations: { type: 'number' }
      }
    }
  },
  {
    name: 'agent_sdlc_memory_lookup',
    description: 'Query historical failure memory for fix hints matching an error signature.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' }
      }
    }
  },
  {
    name: 'agent_sdlc_release_notes',
    description: 'Generate semantic release notes and PR description for a run.',
    inputSchema: {
      type: 'object',
      required: ['run_id'],
      properties: {
        run_id: { type: 'string' },
        version: { type: 'string' },
        bump_type: { type: 'string', enum: ['major', 'minor', 'patch'] }
      }
    }
  }
];

export async function handleMcpGatewayRequest(projectRoot, request) {
  const { method, params = {}, id = 1 } = request || {};

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: GATEWAY_TOOLS }
    };
  }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params;
    try {
      if (name === 'agent_sdlc_dashboard') {
        const tui = renderTuiDashboard({ version: '3.0.0-alpha6' });
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: tui }] }
        };
      }

      if (name === 'agent_sdlc_govern') {
        const res = evaluateBudgetCircuitBreaker(projectRoot, args.run_id, {
          budgetLimits: {
            max_cost_usd: args.max_cost_usd,
            max_tokens: args.max_tokens
          }
        });
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] }
        };
      }

      if (name === 'agent_sdlc_flaky_detect') {
        const res = await detectFlakyTests(projectRoot, {
          command: args.command,
          iterations: args.iterations || 3
        });
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] }
        };
      }

      if (name === 'agent_sdlc_memory_lookup') {
        const res = lookupFailurePattern(projectRoot, args.query);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] }
        };
      }

      if (name === 'agent_sdlc_release_notes') {
        const run = loadRun(projectRoot, args.run_id);
        const res = generateSemanticReleaseNotes(projectRoot, run, {
          version: args.version || '3.0.0',
          bumpType: args.bump_type || 'minor'
        });
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] }
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Tool not found: ${name}` }
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: String(err.message || err) }
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32600, message: `Unsupported method: ${method}` }
  };
}