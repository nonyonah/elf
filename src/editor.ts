/** Package-to-editor discovery without installing code or launching a browser. */
export async function main(argv: string[]): Promise<number> {
  if (argv.some(arg => arg !== '--help' && arg !== '-h')) throw new Error('Usage: elf extension');
  console.log(`Elf for VS Code

The npm package, native editor extension, and MCP adapter share the same engine.
You can keep using npm for local monitoring and automation.

Install Elf from the Visual Studio Marketplace (choose the pre-release version):
https://marketplace.visualstudio.com/items?itemName=NonsoOnah.elf-design-system

Or run:
code --install-extension NonsoOnah.elf-design-system --pre-release

Then open your trusted project and run “Elf: Open Overview”.
Figma Desktop and the Elf Bridge development manifest are required.
Setup: https://elf-docs.riftlabs.xyz/vscode

Continue with npm: elf start
Nothing has been installed or changed by this command.`);
  return 0;
}
