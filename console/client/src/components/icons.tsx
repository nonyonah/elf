import {
  ArchiveIcon as ArchiveGlyph,
  ArrowSquareOutIcon as ArrowSquareOutGlyph,
  ArrowsClockwiseIcon as ArrowsClockwiseGlyph,
  BellIcon as BellGlyph,
  BookOpenIcon as BookOpenGlyph,
  CaretDownIcon as CaretDownGlyph,
  CaretRightIcon as CaretRightGlyph,
  CaretUpDownIcon as CaretUpDownGlyph,
  CaretUpIcon as CaretUpGlyph,
  CheckCircleIcon as CheckCircleGlyph,
  CheckIcon as CheckGlyph,
  CircleNotchIcon as CircleNotchGlyph,
  ClockCounterClockwiseIcon as ClockCounterClockwiseGlyph,
  CodeIcon as CodeGlyph,
  CopyIcon as CopyGlyph,
  CubeIcon as CubeGlyph,
  DotsThreeIcon as DotsThreeGlyph,
  DownloadSimpleIcon as DownloadSimpleGlyph,
  FolderOpenIcon as FolderOpenGlyph,
  FolderSimpleIcon as FolderSimpleGlyph,
  GearSixIcon as GearSixGlyph,
  GitBranchIcon as GitBranchGlyph,
  GitDiffIcon as GitDiffGlyph,
  GithubLogoIcon as GithubLogoGlyph,
  HouseIcon as HouseGlyph,
  HourglassIcon as HourglassGlyph,
  InfoIcon as InfoGlyph,
  KeyIcon as KeyGlyph,
  MagnifyingGlassIcon as MagnifyingGlassGlyph,
  PaperPlaneTiltIcon as PaperPlaneTiltGlyph,
  PaintBrushIcon as PaintBrushGlyph,
  PencilSimpleIcon as PencilSimpleGlyph,
  PenNibIcon as PenNibGlyph,
  PlugsIcon as PlugsGlyph,
  PlusIcon as PlusGlyph,
  SidebarSimpleIcon as SidebarSimpleGlyph,
  SignOutIcon as SignOutGlyph,
  SlackLogoIcon as SlackLogoGlyph,
  SlidersHorizontalIcon as SlidersHorizontalGlyph,
  SparkleIcon as SparkleGlyph,
  SquaresFourIcon as SquaresFourGlyph,
  StackIcon as StackGlyph,
  TrashIcon as TrashGlyph,
  UserCircleIcon as UserCircleGlyph,
  UsersIcon as UsersGlyph,
  WarningCircleIcon as WarningCircleGlyph,
  WarningIcon as WarningGlyph,
  XIcon as XGlyph,
} from "@phosphor-icons/react";
import type {
  Icon as PhosphorIcon,
  IconProps as PhosphorIconProps,
} from "@phosphor-icons/react";
import type * as React from "react";

type IconProps = Omit<PhosphorIconProps, "weight"> & {
  weight?: PhosphorIconProps["weight"];
};

function icon(Glyph: PhosphorIcon) {
  return function Icon({ weight = "fill", ...props }: IconProps): React.ReactElement {
    return <Glyph weight={weight} {...props} />;
  };
}

export const Archive = icon(ArchiveGlyph);
export const ArrowSquareOut = icon(ArrowSquareOutGlyph);
export const ArrowsClockwise = icon(ArrowsClockwiseGlyph);
export const Bell = icon(BellGlyph);
export const BookOpen = icon(BookOpenGlyph);
export const Box = icon(CubeGlyph);
export const Boxes = icon(StackGlyph);
export const CaretDown = icon(CaretDownGlyph);
export const CaretRight = icon(CaretRightGlyph);
export const CaretUp = icon(CaretUpGlyph);
export const CaretUpDown = icon(CaretUpDownGlyph);
export const Check = icon(CheckGlyph);
export const CheckCircle = icon(CheckCircleGlyph);
export const ChevronDownIcon = icon(CaretDownGlyph);
export const ChevronRight = icon(CaretRightGlyph);
export const ChevronRightIcon = icon(CaretRightGlyph);
export const ChevronUpIcon = icon(CaretUpGlyph);
export const ChevronsUpDown = icon(CaretUpDownGlyph);
export const ChevronsUpDownIcon = icon(CaretUpDownGlyph);
export const CircleAlert = icon(WarningCircleGlyph);
export const CircleAlertIcon = icon(WarningCircleGlyph);
export const CircleCheck = icon(CheckCircleGlyph);
export const CircleCheckIcon = icon(CheckCircleGlyph);
export const ClockCounterClockwise = icon(ClockCounterClockwiseGlyph);
export const Code = icon(CodeGlyph);
export const CodeXml = icon(CodeGlyph);
export const Copy = icon(CopyGlyph);
export const DotsThree = icon(DotsThreeGlyph);
export const Download = icon(DownloadSimpleGlyph);
export const FolderOpen = icon(FolderOpenGlyph);
export const FolderSimple = icon(FolderSimpleGlyph);
export const GearSix = icon(GearSixGlyph);
export const GitBranch = icon(GitBranchGlyph);
export const GitCompareArrows = icon(GitDiffGlyph);
export const GithubLogo = icon(GithubLogoGlyph);
export const History = icon(ClockCounterClockwiseGlyph);
export const House = icon(HouseGlyph);
export const Hourglass = icon(HourglassGlyph);
export const InfoIcon = icon(InfoGlyph);
export const KeyRound = icon(KeyGlyph);
export const LayoutDashboard = icon(SquaresFourGlyph);
export const Loader2Icon = icon(CircleNotchGlyph);
export const LoaderCircleIcon = icon(CircleNotchGlyph);
export const LogOut = icon(SignOutGlyph);
export const MagnifyingGlass = icon(MagnifyingGlassGlyph);
export const MoreHorizontal = icon(DotsThreeGlyph);
export const PanelLeftIcon = icon(SidebarSimpleGlyph);
export const PaintBrush = icon(PaintBrushGlyph);
export const Pencil = icon(PencilSimpleGlyph);
export const PenTool = icon(PenNibGlyph);
export const Plug = icon(PlugsGlyph);
export const Plugs = icon(PlugsGlyph);
export const Plus = icon(PlusGlyph);
export const RefreshCw = icon(ArrowsClockwiseGlyph);
export const Search = icon(MagnifyingGlassGlyph);
export const Send = icon(PaperPlaneTiltGlyph);
export const Settings = icon(GearSixGlyph);
export const SidebarSimple = icon(SidebarSimpleGlyph);
export const SignOut = icon(SignOutGlyph);
export const SlackLogo = icon(SlackLogoGlyph);
export const SlidersHorizontal = icon(SlidersHorizontalGlyph);
export const Sparkles = icon(SparkleGlyph);
export const SquaresFour = icon(SquaresFourGlyph);
export const Trash2 = icon(TrashGlyph);
export const TriangleAlert = icon(WarningGlyph);
export const TriangleAlertIcon = icon(WarningGlyph);
export const UserCircle = icon(UserCircleGlyph);
export const Users = icon(UsersGlyph);
export const Warning = icon(WarningGlyph);
export const XIcon = icon(XGlyph);
