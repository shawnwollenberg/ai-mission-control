export interface GitCredentialProvider {
  environment(reference?: string): Promise<Record<string, string>>;
}
export class LocalGitCredentialProvider implements GitCredentialProvider {
  async environment(reference?: string) {
    if (reference && !reference.startsWith("local-config:"))
      throw new Error("Unsupported local Git credential reference");
    const configured = reference?.slice("local-config:".length);
    return {
      ...(configured ? { GH_CONFIG_DIR: configured } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
    };
  }
}
