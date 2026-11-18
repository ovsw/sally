import * as React from "react";

import { AppShell } from "@/components/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { navigate, usePath } from "@/lib/router";
import { ActivityScreen } from "@/screens/activity-screen";
import { AttentionScreen } from "@/screens/attention-screen";
import { ImportScreen } from "@/screens/import-screen";
import { GuideScreen } from "@/screens/guide-screen";
import { RulesScreen } from "@/screens/rules-screen";
import { SettingsScreen } from "@/screens/settings-screen";

function Screen({ path }: { path: string }) {
  // An open rule shows beside the list, so the list stays as it was.
  const rule = path.match(/^\/rules\/(\d+)$/);
  if (rule) return <RulesScreen openId={Number(rule[1])} />;
  const importPassage = path.match(/^\/imports\/(\d+)(?:\/passages\/(\d+))?$/);
  if (importPassage) {
    const position = importPassage[2] === undefined ? undefined : Number(importPassage[2]);
    return <ImportScreen key={path} id={Number(importPassage[1])} position={position} />;
  }
  if (path === "/settings") return <SettingsScreen />;
  if (path === "/activity") return <ActivityScreen />;
  if (path === "/guide") return <GuideScreen />;
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
