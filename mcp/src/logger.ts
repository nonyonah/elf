export interface Logger {
  log(message: string): void;
}

/**
 * MCP servers speak over stdio: stdout is reserved for protocol messages, so
 * every diagnostic goes to stderr.
 */
export const stderrLogger: Logger = {
  log: (message: string) => {
    process.stderr.write(`elf-mcp: ${message}\n`);
  },
};

export const silentLogger: Logger = {
  log: () => {},
};