"use client";

import {
  BarChart3,
  BookOpen,
  Building2,
  CalendarDays,
  ClipboardCheck,
  ConciergeBell,
  GraduationCap,
  LayoutDashboard,
  Settings,
  ShieldCheck,
  UserRound,
  Users,
  Wallet,
} from "lucide-react";
import type { ComponentType } from "react";
import type { ShellIconName } from "@/components/shell/nav";

const ICONS: Record<ShellIconName, ComponentType<{ className?: string }>> = {
  dashboard: LayoutDashboard,
  reception: ConciergeBell,
  sessions: CalendarDays,
  classes: BookOpen,
  students: Users,
  teachers: GraduationCap,
  analytics: BarChart3,
  expenses: Wallet,
  approvals: ClipboardCheck,
  settings: Settings,
  schedule: CalendarDays,
  discover: BookOpen,
  centers: Building2,
  platform: ShieldCheck,
};

export function ShellIcon({
  name,
  className,
}: {
  name: ShellIconName;
  className?: string;
}) {
  const Icon = ICONS[name] ?? UserRound;
  return <Icon className={className} />;
}
