import {
  Archive as ArchiveGlyph,
  Bell as BellGlyph,
  Box as BoxGlyph,
  Boxes as BoxesGlyph,
  Check as CheckGlyph,
  ChevronDownIcon as ChevronDownGlyph,
  ChevronRight as ChevronRightGlyph,
  ChevronRightIcon as ChevronRightIconGlyph,
  ChevronUpIcon as ChevronUpGlyph,
  ChevronsUpDown as ChevronsUpDownGlyph,
  CircleAlert as CircleAlertGlyph,
  CircleCheckIcon as CircleCheckGlyph,
  Copy as CopyGlyph,
  Download as DownloadGlyph,
  GitBranch as GitBranchGlyph,
  GitCompareArrows as GitCompareArrowsGlyph,
  History as HistoryGlyph,
  Hourglass as HourglassGlyph,
  InfoIcon as InfoGlyph,
  KeyRound as KeyRoundGlyph,
  LayoutDashboard as LayoutDashboardGlyph,
  LoaderCircleIcon as LoaderCircleGlyph,
  LogOut as LogOutGlyph,
  MoreHorizontal as MoreHorizontalGlyph,
  PanelLeftIcon as PanelLeftGlyph,
  Pencil as PencilGlyph,
  Plug as PlugGlyph,
  Plus as PlusGlyph,
  RefreshCw as RefreshCwGlyph,
  Search as SearchGlyph,
  Send as SendGlyph,
  Settings as SettingsGlyph,
  Sparkles as SparklesGlyph,
  Trash2 as Trash2Glyph,
  TriangleAlertIcon as TriangleAlertGlyph,
  Users as UsersGlyph,
  XIcon as XGlyph,
} from "@hugeicons/core-free-icons";
import {
  HugeiconsIcon,
  type HugeiconsIconProps,
  type IconSvgElement,
} from "@hugeicons/react";
import type * as React from "react";

type IconProps = Omit<HugeiconsIconProps, "icon">;

function icon(glyph: IconSvgElement) {
  return function Icon(props: IconProps): React.ReactElement {
    return <HugeiconsIcon icon={glyph} {...props} />;
  };
}

export const Archive = icon(ArchiveGlyph);
export const Bell = icon(BellGlyph);
export const Box = icon(BoxGlyph);
export const Boxes = icon(BoxesGlyph);
export const Check = icon(CheckGlyph);
export const ChevronDownIcon = icon(ChevronDownGlyph);
export const ChevronRight = icon(ChevronRightGlyph);
export const ChevronRightIcon = icon(ChevronRightIconGlyph);
export const ChevronUpIcon = icon(ChevronUpGlyph);
export const ChevronsUpDown = icon(ChevronsUpDownGlyph);
export const ChevronsUpDownIcon = icon(ChevronsUpDownGlyph);
export const CircleAlert = icon(CircleAlertGlyph);
export const CircleAlertIcon = icon(CircleAlertGlyph);
export const CircleCheckIcon = icon(CircleCheckGlyph);
export const Copy = icon(CopyGlyph);
export const Download = icon(DownloadGlyph);
export const GitBranch = icon(GitBranchGlyph);
export const GitCompareArrows = icon(GitCompareArrowsGlyph);
export const History = icon(HistoryGlyph);
export const Hourglass = icon(HourglassGlyph);
export const InfoIcon = icon(InfoGlyph);
export const KeyRound = icon(KeyRoundGlyph);
export const LayoutDashboard = icon(LayoutDashboardGlyph);
export const Loader2Icon = icon(LoaderCircleGlyph);
export const LoaderCircleIcon = icon(LoaderCircleGlyph);
export const LogOut = icon(LogOutGlyph);
export const MoreHorizontal = icon(MoreHorizontalGlyph);
export const PanelLeftIcon = icon(PanelLeftGlyph);
export const Pencil = icon(PencilGlyph);
export const Plug = icon(PlugGlyph);
export const Plus = icon(PlusGlyph);
export const RefreshCw = icon(RefreshCwGlyph);
export const Search = icon(SearchGlyph);
export const Send = icon(SendGlyph);
export const Settings = icon(SettingsGlyph);
export const Sparkles = icon(SparklesGlyph);
export const Trash2 = icon(Trash2Glyph);
export const TriangleAlert = icon(TriangleAlertGlyph);
export const TriangleAlertIcon = icon(TriangleAlertGlyph);
export const Users = icon(UsersGlyph);
export const XIcon = icon(XGlyph);
