import { AlertCircle, CheckCircle2, Info } from "lucide-react";

import { cn } from "@/lib/utils";

const TONES = {
  error: {
    className: "border-danger/30 bg-danger-bg text-danger-fg",
    Icon: AlertCircle,
  },
  success: {
    className: "border-success/30 bg-success-bg text-success-fg",
    Icon: CheckCircle2,
  },
  info: {
    className: "border-info/30 bg-info-bg text-info-fg",
    Icon: Info,
  },
  warning: {
    className: "border-warning/30 bg-warning-bg text-warning-fg",
    Icon: AlertCircle,
  },
} as const;

export function FormMessage({
  tone = "error",
  children,
  className,
}: {
  tone?: keyof typeof TONES;
  children: React.ReactNode;
  className?: string;
}) {
  const { className: toneClass, Icon } = TONES[tone];

  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        toneClass,
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

export function FieldError({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <p id={id} className="text-xs font-medium text-danger-fg">
      {children}
    </p>
  );
}
