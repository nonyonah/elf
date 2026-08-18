export type Category = "color" | "spacing" | "typography";

export interface Token {
  name: string;
  category: Category;
  value: string;
  source: "figma" | "code";
}

export type FigmaSource = "auto" | "variables" | "styles";

export type CodebaseSource = "auto" | "tailwind" | "css" | "tokens-json";

export interface DriftConfig {
  figma: {
    fileKey: string;
    apiTokenEnv: string;
    source: FigmaSource;
    teamId?: string;
  };
  codebase: {
    path: string;
    source: CodebaseSource;
  };
  modeName?: string | null;
  nameMapping: Record<string, string>;
  webhook?: {
    endpoint?: string;
    eventTypes?: string[];
    passcodeEnv?: string;
  };
}
