import * as React from "react";

import { AppShell } from "@/components/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { navigate, usePath } from "@/lib/router";
import { RuleScreen } from "@/screens/rule-screen";
import { RulesScreen } from "@/screens/rules-screen";
import { SettingsScreen } from "@/screens/settings-screen";

function Screen({ path }: { path: string }) {
  const rule = path.match(/^\/rules\/(\d+)$/);
  if (rule) return <RuleScreen key={rule[1]} id={Number(rule[1])} />;
  if (path === "/settings") return <SettingsScreen />;
  return <RulesScreen />;
}

export function App() {
  const path = usePath();
  React.useEffect(() => {
    if (path === "/" || path === "/index.html") navigate("/rules");
  }, [path]);
  return (
    <TooltipProvider>
      <AppShell path={path}>
        <Screen path={path} />
      </AppShell>
    </TooltipProvider>
  );
}
