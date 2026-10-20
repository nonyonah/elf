import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          SECRETS_KEY: Buffer.from("elf-console-test-secrets-key-32b").toString("base64"),
          // Never inherit the local-preview bypass from .dev.vars: signed-out
          // tests must stay signed out.
          DEV_ONLY_FAKE_USER: "",
          CONSOLE_ORIGIN: "https://console.test",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
