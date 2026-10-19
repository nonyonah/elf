export type DriftState = "ok" | "drift" | "stale" | "unknown";

export type TokenCategory =
  | "color"
  | "spacing"
  | "typography"
  | "radius"
  | "shadow";

export interface Token {
  name: string;
  category: TokenCategory;
  value: string;
  source: "figma" | "code";
  mode?: string;
}

export interface ValueMismatch {
  name: string;
  category: string;
  figmaValue: string;
  codeValue: string;
  mode?: string;
}

export interface ComponentIssue {
  name: string;
  codeKey?: string;
  file?: string;
  nodeId?: string;
  detail?: string;
}

export interface DriftItem {
  kind: "token" | "component";
  name: string;
  detail?: string;
}

export interface DriftResult {
  valueMismatches: ValueMismatch[];
  missingInCode: Token[];
  missingInFigma: Token[];
  componentsOutOfDate: ComponentIssue[];
  componentsChangedInFigma: ComponentIssue[];
  componentsInCodeNotInFigma: ComponentIssue[];
  componentsInFigmaNotInCode: ComponentIssue[];
  deprecatedStillInCode: DriftItem[];
  deprecationOverdue: DriftItem[];
  safeToRemoveFromDeprecations: DriftItem[];
  driftFound: boolean;
}

export interface DriftCounts {
  valueMismatches: number;
  missingInCode: number;
  missingInFigma: number;
  componentsOutOfDate: number;
  componentsChangedInFigma: number;
  componentsInCodeNotInFigma: number;
  componentsInFigmaNotInCode: number;
  deprecatedStillInCode: number;
  deprecationOverdue: number;
  safeToRemoveFromDeprecations: number;
}

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
}

export interface ProjectSummaryEntry {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  state: DriftState;
  checkedAt: string;
  counts: Partial<DriftCounts>;
  lastActivity: string;
  fileKey: string | null;
  fileName: string | null;
  tokenCounts: { figma: number; code: number } | null;
  componentCount: number | null;
}

export interface WorkspaceSummary {
  total: number;
  ok: number;
  drift: number;
  stale: number;
  unknown: number;
  lastCheckedAt: string | null;
}

export interface TrendPoint {
  date: string;
  total: number;
}

export interface RunTrendPoint {
  createdAt: string;
  state: DriftState;
  total: number;
}

export interface OverviewResponse {
  workspace: Workspace;
  summary: WorkspaceSummary;
  trend: TrendPoint[];
  projects: ProjectSummaryEntry[];
}

export interface ProjectDetailResponse {
  project: { id: string; name: string; slug: string; createdAt: string };
  state: DriftState;
  staleReason: "age" | "figma" | null;
  checkedAt: string;
  counts: Partial<DriftCounts>;
  details: DriftResult | null;
  detailsError: string | null;
  fileKey: string | null;
  fileName: string | null;
  trend: RunTrendPoint[];
  latestCode: {
    receivedAt: string;
    gitBranch: string | null;
    gitCommit: string | null;
    tokenCounts: { figma: number; code: number };
    componentCount: number;
  } | null;
  latestFigma: {
    receivedAt: string;
    tokenCount: number;
    componentCount: number;
  } | null;
}

export interface Deprecation {
  id: string;
  name: string;
  type: "token" | "component";
  reason: string | null;
  since: string | null;
  removeBy: string | null;
  createdAt: string;
}

export type ConnectionType = "figma" | "slack";

export interface ConnectionView {
  type: ConnectionType;
  status: "unconfigured" | "bound" | "configured" | "error";
  statusMessage: string | null;
  secretTail: string | null;
  fileKey: string | null;
  fileName: string | null;
  updatedAt: string | null;
}

export type NotificationMode = "change" | "always" | "never";

export interface NotificationRules {
  mode: NotificationMode;
  overdueAlways: boolean;
}

export type TokenKind = "push" | "plugin";

export interface TokenSummary {
  id: string;
  kind: TokenKind;
  label: string | null;
  last4: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface IssuedToken {
  token: string;
  tokenInfo: TokenSummary;
}

export interface WorkspaceMember {
  userId: string;
  role: string;
  createdAt: string;
}

export interface WorkspaceResponse {
  workspace: Workspace;
  members: WorkspaceMember[];
}

export interface ActivityEntry {
  id: string;
  actor: string;
  action: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
  project: { id: string; name: string } | null;
}

export interface ActivityResponse {
  entries: ActivityEntry[];
  hasMore: boolean;
}
