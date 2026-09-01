import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LocaleSwitcher } from "@/components/shared/locale-switcher";

export default function HomePage() {
  const t = useTranslations("HomePage");

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 bg-background p-8">
      <div className="flex w-full max-w-md justify-end">
        <LocaleSwitcher />
      </div>
      <Card className="w-full max-w-md border-t-4 border-t-brand">
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("body")}</p>
        </CardContent>
        <CardFooter>
          <Button>{t("cta")}</Button>
        </CardFooter>
      </Card>
    </div>
  );
}
