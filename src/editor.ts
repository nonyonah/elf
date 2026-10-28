/** Package-to-editor discovery without installing code or launching a browser. */
export async function main(argv: string[]): Promise<number> {
  if (argv.some(arg => arg !== '--help' && arg !== '-h')) throw new Error('Usage: elf extension');
  console.log(`Elf for VS Code

The npm package, native editor extension, and MCP adapter share the same engine.
You can keep using npm for local monitoring, automation, and CI.

The extension is currently a local preview, not a Marketplace release.
Install a prepared Elf .vsix with Extensions → … → Install from VSIX…,
then run “Elf: Open Overview” in your project. No repository clone is needed
when installing a prepared package.

Preview instructions and release status:
https://github.com/nonyonah/elf/blob/main/extension/README.md

Continue with npm: elf start
Nothing has been installed or changed by this command.`);
  return 0;
}
