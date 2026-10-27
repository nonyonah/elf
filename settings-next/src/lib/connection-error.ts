/** Codes are intentionally fixed; provider text and credentials never enter UI copy. */
export function figmaConnectionError(reason: string | null): string {
  const messages: Record<string, string> = {
    access_denied: "Figma authorization was declined. Connect again when you’re ready.",
    invalid_client: "Figma rejected Elf’s app credentials. Check the Figma Client ID and Client Secret on the Elf Console Worker.",
    invalid_grant: "Figma rejected the authorization code. Start a fresh connection and check the app’s registered callback URL if it repeats.",
    redirect_uri_mismatch: "Figma’s registered callback URL does not match Elf’s connection service.",
    invalid_scope: "The Figma app must allow the file_content:read permission.",
    unauthorized_client: "The Figma app is not authorized for this account. Check its publishing status and team access.",
    expired_session: "This connection session expired or Elf restarted. Start Connect Figma again.",
    local_exchange: "Elf could not finish or save this account connection locally. Retry with Elf still running.",
    credential_storage: "Elf’s connection service could not securely store the account grant. Check the Worker’s SECRETS_KEY configuration.",
    provider_rejected: "Figma rejected the token exchange. Check the app credentials, callback URL, and publishing status, then retry.",
    service_error: "Elf’s connection service could not complete authorization. Retry; if it persists, check the Worker configuration.",
  };
  return messages[reason ?? ""] ?? "Figma account connection failed. Start a fresh connection and try again.";
}
