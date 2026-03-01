/**
 * Tool Runner - Shared CLI Bootstrap
 *
 * Eliminates duplicated argument parsing, help generation, and error handling
 * across CLI tools by providing a standardized runner using node:util.parseArgs.
 *
 * @example
 * ```typescript
 * import { runTool } from '../shared/lib/tool-runner.ts';
 *
 * runTool({
 *   name: 'my-tool',
 *   description: 'Does something useful',
 *   options: {
 *     file: { type: 'string', description: 'File to process' },
 *     verbose: { type: 'boolean', short: 'v', description: 'Verbose output' },
 *   },
 *   examples: [
 *     'npx tsx tools/my-tool.ts --file input.txt',
 *     'npx tsx tools/my-tool.ts --verbose',
 *   ],
 *   async run({ args, positional }) {
 *     console.log('Processing:', args.file);
 *   },
 * });
 * ```
 *
 * @module tool-runner
 */

import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Option type configuration
 */
export interface OptionConfig {
  /** Option value type */
  type: 'string' | 'boolean';
  /** Short flag alternative (e.g., 'h' for -h) */
  short?: string;
  /** Description for help text */
  description: string;
  /** Whether option can be specified multiple times */
  multiple?: boolean;
  /** Default value */
  default?: string | boolean;
}

/**
 * Positional arguments configuration
 */
export interface PositionalConfig {
  /** Name of positional argument(s) */
  name: string;
  /** Description for help text */
  description: string;
  /** Whether multiple positional args are allowed */
  multiple?: boolean;
  /** Whether positional arg is required */
  required?: boolean;
}

/**
 * Tool configuration
 */
export interface ToolConfig<TOptions extends Record<string, OptionConfig>> {
  /** Tool name (for help text) */
  name: string;
  /** Tool description */
  description: string;
  /** Option definitions */
  options: TOptions;
  /** Positional argument config */
  positional?: PositionalConfig;
  /** Usage examples (one per array element) */
  examples?: string[];
  /** Additional help text sections */
  additionalHelp?: string;
  /** Handler function */
  run: (context: RunContext<TOptions>) => void | Promise<void>;
}

/**
 * Context passed to run handler
 */
export interface RunContext<TOptions extends Record<string, OptionConfig>> {
  /** Parsed option values */
  args: ParsedArgs<TOptions>;
  /** Positional arguments */
  positional: string[];
  /** Raw argv */
  rawArgv: string[];
}

/**
 * Infer parsed args type from option config
 */
export type ParsedArgs<TOptions extends Record<string, OptionConfig>> = {
  [K in keyof TOptions]: TOptions[K]['multiple'] extends true
    ? TOptions[K]['type'] extends 'string'
      ? string[]
      : boolean[]
    : TOptions[K]['type'] extends 'string'
    ? string | undefined
    : boolean | undefined;
};

// ── Help Generation ──────────────────────────────────────────────────────────

/**
 * Generate help text from tool configuration
 */
function generateHelp<TOptions extends Record<string, OptionConfig>>(
  config: ToolConfig<TOptions>
): string {
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push(`${config.name} - ${config.description}`);
  lines.push('');

  // Usage
  const optionsPlaceholder = Object.keys(config.options).length > 0 ? '[options]' : '';
  const positionalPlaceholder = config.positional
    ? config.positional.multiple
      ? `[${config.positional.name}...]`
      : `[${config.positional.name}]`
    : '';

  lines.push('Usage:');
  lines.push(`  ${config.name} ${optionsPlaceholder} ${positionalPlaceholder}`.trim());
  lines.push('');

  // Options
  if (Object.keys(config.options).length > 0) {
    lines.push('Options:');

    const entries = Object.entries(config.options);
    const maxLength = Math.max(
      ...entries.map(([name, opt]) => {
        const shortPart = opt.short ? `-${opt.short}, ` : '';
        const longPart = opt.type === 'string' ? `--${name} <value>` : `--${name}`;
        return (shortPart + longPart).length;
      })
    );

    for (const [name, opt] of entries) {
      const shortPart = opt.short ? `-${opt.short}, ` : '    ';
      const longPart = opt.type === 'string' ? `--${name} <value>` : `--${name}`;
      const flag = (shortPart + longPart).padEnd(maxLength + 2);

      let desc = opt.description;
      if (opt.default !== undefined) {
        desc += ` (default: ${opt.default})`;
      }

      lines.push(`  ${flag}  ${desc}`);
    }
    lines.push('');
  }

  // Positional arguments
  if (config.positional) {
    lines.push('Arguments:');
    const name = config.positional.multiple
      ? `${config.positional.name}...`
      : config.positional.name;
    const required = config.positional.required ? ' (required)' : '';
    lines.push(`  ${name.padEnd(20)}  ${config.positional.description}${required}`);
    lines.push('');
  }

  // Examples
  if (config.examples && config.examples.length > 0) {
    lines.push('Examples:');
    for (const example of config.examples) {
      if (example === '') {
        lines.push('');
      } else if (example.startsWith('#')) {
        lines.push(`  ${example}`);
      } else {
        lines.push(`  ${example}`);
      }
    }
    lines.push('');
  }

  // Additional help
  if (config.additionalHelp) {
    lines.push(config.additionalHelp);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Argument Parsing ─────────────────────────────────────────────────────────

/**
 * Parse command-line arguments using node:util.parseArgs
 */
function parseArguments<TOptions extends Record<string, OptionConfig>>(
  config: ToolConfig<TOptions>,
  argv: string[]
): { args: ParsedArgs<TOptions>; positional: string[] } {
  // Build parseArgs config
  const parseConfig: ParseArgsConfig = {
    options: {},
    strict: true,
    allowPositionals: true,
    args: argv,
  };

  // Convert our option config to node:util format
  for (const [name, opt] of Object.entries(config.options)) {
    const optConfig: any = {
      type: opt.type,
    };

    // Only add optional fields if they're defined
    if (opt.short !== undefined) {
      optConfig.short = opt.short;
    }
    if (opt.multiple !== undefined) {
      optConfig.multiple = opt.multiple;
    }
    if (opt.default !== undefined) {
      optConfig.default = opt.default;
    }

    parseConfig.options![name] = optConfig;
  }

  // Parse with node:util.parseArgs
  const { values, positionals } = parseArgs(parseConfig);

  // Cast to our typed format
  const args = values as ParsedArgs<TOptions>;

  return { args, positional: positionals };
}

// ── Main Runner ──────────────────────────────────────────────────────────────

/**
 * Run a CLI tool with standardized argument parsing, help, and error handling
 *
 * @param config Tool configuration
 * @param argv Command-line arguments (defaults to process.argv.slice(2))
 *
 * @example
 * ```typescript
 * runTool({
 *   name: 'my-tool',
 *   description: 'Process files',
 *   options: {
 *     input: { type: 'string', description: 'Input file' },
 *     verbose: { type: 'boolean', short: 'v', description: 'Verbose output' },
 *     help: { type: 'boolean', short: 'h', description: 'Show help' },
 *   },
 *   examples: ['npx tsx tools/my-tool.ts --input file.txt'],
 *   async run({ args }) {
 *     console.log('Processing:', args.input);
 *   },
 * });
 * ```
 */
export async function runTool<TOptions extends Record<string, OptionConfig>>(
  config: ToolConfig<TOptions>,
  argv: string[] = process.argv.slice(2)
): Promise<void> {
  try {
    // Parse arguments
    const { args, positional } = parseArguments(config, argv);

    // Check for help flag (always supported)
    if ('help' in args && args.help) {
      console.log(generateHelp(config));
      process.exit(0);
    }

    // Validate required positional args
    if (config.positional?.required && positional.length === 0) {
      console.error(`Error: ${config.positional.name} is required`);
      console.error('');
      console.log(generateHelp(config));
      process.exit(1);
    }

    // Run the handler
    await config.run({
      args,
      positional,
      rawArgv: argv,
    });
  } catch (error) {
    // Handle parsing errors
    if (error instanceof Error) {
      if (error.message.includes('Unknown option')) {
        console.error(`Error: ${error.message}`);
        console.error('');
        console.error('Run with --help to see available options');
        process.exit(1);
      }

      // Other errors
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }

    // Unknown error type
    console.error('Error:', error);
    process.exit(1);
  }
}

/**
 * Synchronous version of runTool for tools that don't need async
 */
export function runToolSync<TOptions extends Record<string, OptionConfig>>(
  config: Omit<ToolConfig<TOptions>, 'run'> & {
    run: (context: RunContext<TOptions>) => void;
  },
  argv: string[] = process.argv.slice(2)
): void {
  runTool(config as ToolConfig<TOptions>, argv).catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}
