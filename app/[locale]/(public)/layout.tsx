import { PublicShell } from "@/components/explore/public-shell";
import { getCurrentUser } from "@/lib/auth/session";

/**
 * The public experience (F5): Explore, for anyone, signed in or not. No gate —
 * every read below goes through `lib/db/public-catalog.ts`, which lists only
 * what a guest may see (`npm run check:public`).
 */
export default async function PublicLayout({ children }: LayoutProps<"/[locale]">) {
  const user = await getCurrentUser();
  return <PublicShell signedIn={Boolean(user)}>{children}</PublicShell>;
}
