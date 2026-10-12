"use client";

import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SubmitButton({
  children,
  className,
  variant,
  disabled,
}: {
  children: React.ReactNode;
  className?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  /** Held disabled by the form itself — e.g. an unconfirmed double-booking (R3). */
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      variant={variant}
      disabled={pending || disabled}
      className={cn("h-11 px-4", className)}
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : null}
      {children}
    </Button>
  );
}
