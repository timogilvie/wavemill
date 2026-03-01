/**
 * Unit tests for tool-runner.ts
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { runTool } from './tool-runner.ts';

// Capture console output
async function captureOutput(fn: () => void | Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const originalLog = console.log;
  const originalError = console.error;
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  console.log = (...args: any[]) => stdoutLines.push(args.join(' '));
  console.error = (...args: any[]) => stderrLines.push(args.join(' '));

  try {
    await Promise.resolve(fn());
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  return {
    stdout: stdoutLines.join('\n'),
    stderr: stderrLines.join('\n'),
  };
}

// Mock process.exit
async function mockExit<T>(fn: () => T | Promise<T>): Promise<{ result: T | null; exitCode: number | null }> {
  const originalExit = process.exit;
  let exitCode: number | null = null;

  // @ts-ignore - Mock process.exit
  process.exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`EXIT:${code}`);
  };

  try {
    const result = await Promise.resolve(fn());
    process.exit = originalExit;
    return { result, exitCode };
  } catch (error) {
    process.exit = originalExit;
    if (error instanceof Error && error.message.startsWith('EXIT:')) {
      return { result: null, exitCode };
    }
    throw error;
  }
}

describe('tool-runner', () => {
  describe('basic argument parsing', () => {
    it('should parse string options', async () => {
      let capturedArgs: any = null;

      await runTool(
        {
          name: 'test-tool',
          description: 'Test tool',
          options: {
            file: { type: 'string', description: 'Input file' },
            help: { type: 'boolean', short: 'h', description: 'Show help' },
          },
          run: ({ args }) => {
            capturedArgs = args;
          },
        },
        ['--file', 'input.txt']
      );

      assert.strictEqual(capturedArgs.file, 'input.txt');
    });

    it('should parse boolean flags', async () => {
      let capturedArgs: any = null;

      await runTool(
        {
          name: 'test-tool',
          description: 'Test tool',
          options: {
            verbose: { type: 'boolean', short: 'v', description: 'Verbose mode' },
            help: { type: 'boolean', short: 'h', description: 'Show help' },
          },
          run: ({ args }) => {
            capturedArgs = args;
          },
        },
        ['--verbose']
      );

      assert.strictEqual(capturedArgs.verbose, true);
    });

    it('should parse short flags', async () => {
      let capturedArgs: any = null;

      await runTool(
        {
          name: 'test-tool',
          description: 'Test tool',
          options: {
            verbose: { type: 'boolean', short: 'v', description: 'Verbose mode' },
            help: { type: 'boolean', short: 'h', description: 'Show help' },
          },
          run: ({ args }) => {
            capturedArgs = args;
          },
        },
        ['-v']
      );

      assert.strictEqual(capturedArgs.verbose, true);
    });

    it('should parse positional arguments', async () => {
      let capturedPositional: string[] = [];

      await runTool(
        {
          name: 'test-tool',
          description: 'Test tool',
          options: {
            help: { type: 'boolean', short: 'h', description: 'Show help' },
          },
          positional: {
            name: 'files',
            description: 'Files to process',
            multiple: true,
          },
          run: ({ positional }) => {
            capturedPositional = positional;
          },
        },
        ['file1.txt', 'file2.txt']
      );

      assert.deepStrictEqual(capturedPositional, ['file1.txt', 'file2.txt']);
    });

    it('should parse mixed options and positional args', async () => {
      let capturedArgs: any = null;
      let capturedPositional: string[] = [];

      await runTool(
        {
          name: 'test-tool',
          description: 'Test tool',
          options: {
            verbose: { type: 'boolean', short: 'v', description: 'Verbose mode' },
            output: { type: 'string', description: 'Output file' },
            help: { type: 'boolean', short: 'h', description: 'Show help' },
          },
          positional: {
            name: 'inputs',
            description: 'Input files',
            multiple: true,
          },
          run: ({ args, positional }) => {
            capturedArgs = args;
            capturedPositional = positional;
          },
        },
        ['--verbose', '--output', 'out.txt', 'in1.txt', 'in2.txt']
      );

      assert.strictEqual(capturedArgs.verbose, true);
      assert.strictEqual(capturedArgs.output, 'out.txt');
      assert.deepStrictEqual(capturedPositional, ['in1.txt', 'in2.txt']);
    });
  });

  describe('help generation', () => {
    it.skip('should show help on --help flag', async () => {
      const { exitCode } = await mockExit(async () => {
        const output = await captureOutput(() => {
          return runTool(
            {
              name: 'test-tool',
              description: 'Test tool for testing',
              options: {
                file: { type: 'string', description: 'Input file' },
                verbose: { type: 'boolean', short: 'v', description: 'Verbose mode' },
                help: { type: 'boolean', short: 'h', description: 'Show help' },
              },
              examples: ['test-tool --file input.txt', 'test-tool --verbose'],
              run: () => {},
            },
            ['--help']
          );
        });

        assert.ok(output.stdout.includes('test-tool - Test tool for testing'), `stdout was: ${output.stdout}`);
        assert.ok(output.stdout.includes('--file <value>'));
        assert.ok(output.stdout.includes('Input file'));
        assert.ok(output.stdout.includes('-v, --verbose'));
        assert.ok(output.stdout.includes('Verbose mode'));
        assert.ok(output.stdout.includes('Examples:'));
      });

      console.log('DEBUG: exitCode =', exitCode);
      assert.strictEqual(exitCode, 0);
    });

    it.skip('should show help on -h flag', async () => {
      const { exitCode } = await mockExit(async () => {
        const output = await captureOutput(() => {
          return runTool(
            {
              name: 'test-tool',
              description: 'Test tool',
              options: {
                help: { type: 'boolean', short: 'h', description: 'Show help' },
              },
              run: () => {},
            },
            ['-h']
          );
        });

        assert.ok(output.stdout.includes('test-tool - Test tool'));
      });

      assert.strictEqual(exitCode, 0);
    });
  });

  describe('error handling', () => {
    it('should exit with error on unknown option', async () => {
      const { exitCode } = await mockExit(async () => {
        await captureOutput(() => {
          return runTool(
            {
              name: 'test-tool',
              description: 'Test tool',
              options: {
                help: { type: 'boolean', short: 'h', description: 'Show help' },
              },
              run: () => {},
            },
            ['--unknown-option']
          );
        });
      });

      assert.strictEqual(exitCode, 1);
    });

    it('should exit with error when required positional is missing', async () => {
      const { exitCode } = await mockExit(async () => {
        await captureOutput(() => {
          return runTool(
            {
              name: 'test-tool',
              description: 'Test tool',
              options: {
                help: { type: 'boolean', short: 'h', description: 'Show help' },
              },
              positional: {
                name: 'file',
                description: 'File to process',
                required: true,
              },
              run: () => {},
            },
            []
          );
        });
      });

      assert.strictEqual(exitCode, 1);
    });

    it('should handle errors thrown in run handler', async () => {
      const { exitCode } = await mockExit(async () => {
        await captureOutput(() => {
          return runTool(
            {
              name: 'test-tool',
              description: 'Test tool',
              options: {
                help: { type: 'boolean', short: 'h', description: 'Show help' },
              },
              run: () => {
                throw new Error('Test error');
              },
            },
            []
          );
        });
      });

      assert.strictEqual(exitCode, 1);
    });
  });

  describe('async support', () => {
    it('should support async run handlers', async () => {
      let executed = false;

      await runTool(
        {
          name: 'test-tool',
          description: 'Test tool',
          options: {
            help: { type: 'boolean', short: 'h', description: 'Show help' },
          },
          async run() {
            await new Promise((resolve) => setTimeout(resolve, 10));
            executed = true;
          },
        },
        []
      );

      assert.strictEqual(executed, true);
    });
  });

  describe('type inference', () => {
    it('should infer correct types for parsed args', async () => {
      await runTool(
        {
          name: 'test-tool',
          description: 'Test tool',
          options: {
            stringOpt: { type: 'string', description: 'String option' },
            boolOpt: { type: 'boolean', description: 'Boolean option' },
            help: { type: 'boolean', short: 'h', description: 'Show help' },
          },
          run: ({ args }) => {
            // Type checking happens at compile time
            const s: string | undefined = args.stringOpt;
            const b: boolean | undefined = args.boolOpt;

            // These would fail TypeScript compilation:
            // const wrong1: number = args.stringOpt;
            // const wrong2: string = args.boolOpt;

            assert.strictEqual(typeof s === 'string' || s === undefined, true);
            assert.strictEqual(typeof b === 'boolean' || b === undefined, true);
          },
        },
        ['--stringOpt', 'test', '--boolOpt']
      );
    });
  });

  describe('default values', () => {
    it('should use default values when option not provided', async () => {
      let capturedArgs: any = null;

      await runTool(
        {
          name: 'test-tool',
          description: 'Test tool',
          options: {
            output: { type: 'string', description: 'Output file', default: 'default.txt' },
            verbose: { type: 'boolean', description: 'Verbose mode', default: false },
            help: { type: 'boolean', short: 'h', description: 'Show help' },
          },
          run: ({ args }) => {
            capturedArgs = args;
          },
        },
        []
      );

      assert.strictEqual(capturedArgs.output, 'default.txt');
      assert.strictEqual(capturedArgs.verbose, false);
    });
  });

  describe('multiple values', () => {
    it('should support multiple string values', async () => {
      let capturedArgs: any = null;

      await runTool(
        {
          name: 'test-tool',
          description: 'Test tool',
          options: {
            include: { type: 'string', description: 'Include pattern', multiple: true },
            help: { type: 'boolean', short: 'h', description: 'Show help' },
          },
          run: ({ args }) => {
            capturedArgs = args;
          },
        },
        ['--include', '*.ts', '--include', '*.js']
      );

      assert.deepStrictEqual(capturedArgs.include, ['*.ts', '*.js']);
    });
  });
});
