import {
  ArrowLeftRight,
  Building2,
  GraduationCap,
  Layers,
  Presentation,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { ExperienceIcon } from "@/lib/auth/experiences";

const ICONS: Record<ExperienceIcon, LucideIcon> = {
  branch: Building2,
  wholeManagement: Layers,
  student: GraduationCap,
  teacher: Presentation,
  parent: Users,
  admin: ShieldCheck,
};

/** An experience's mark (W5). Decorative: the row or button always names it in text. */
export function ExperienceGlyph({ icon, className }: { icon: ExperienceIcon | null; className?: string }) {
  const Icon = icon ? ICONS[icon] : ArrowLeftRight;
  return <Icon className={className} aria-hidden />;
}
