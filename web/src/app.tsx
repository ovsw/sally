import * as React from "react";

import { AppShell } from "@/components/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { navigate, usePath } from "@/lib/router";
import { ActivityScreen } from "@/screens/activity-screen";
import { AttentionScreen } from "@/screens/attention-screen";
import { RuleScreen } from "@/screens/rule-screen";
import { RulesScreen } from "@/screens/rules-screen";

function Screen({ path }: { path: string }) {
  const rule = path.match(/^\/rules\/(\d+)$/);
  if (rule) return <RuleScreen key={rule[1]} id={Number(rule[1])} />;
  if (path === "/activity") return <ActivityScreen />;
  if (path === "/attention" || path === "/" || path === "/index.html") return <AttentionScreen />;
  return <RulesScreen />;
}

export function App() {
  const path = usePath();
  React.useEffect(() => {
    if (path === "/" || path === "/index.html") navigate("/attention");
  }, [path]);
  return (
    <TooltipProvider>
      <AppShell path={path}>
        <Screen path={path} />
      </AppShell>
    </TooltipProvider>
  );
}
