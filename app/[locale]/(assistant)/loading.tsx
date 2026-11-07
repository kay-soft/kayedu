import { SkeletonPage } from "@/components/shared/skeleton";

/** The assistant experience's loading state (W7a; docs/04 §5 "Loading state"). */
export default function AssistantLoading() {
  return <SkeletonPage stats={0} />;
}
