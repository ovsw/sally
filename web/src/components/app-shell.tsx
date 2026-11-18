// Adapted from the shadcnblocks block application-shell2 (inset sidebar with
// icon collapse).
import { Activity, BellDot, BookOpen, FileInput, ListChecks, Settings, Sparkle } from "lucide-react";
import * as React from "react";
import { cn } from "cn";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { IMPORTS_CHANGED, type ImportSummary, listImports } from "@/lib/api";
import { followLink } from "@/lib/router";

type NavItem = {
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  href: string;
};

type NavGroup = {
  title: string;
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  {
    title: "Tend",
    items: [
      { label: "Needs attention", icon: BellDot, href: "/attention" },
      { label: "Rules", icon: ListChecks, href: "/rules" },
      { label: "Activity", icon: Activity, href: "/activity" },
    ],
  },
  {
    title: "Engine",
    items: [{ label: "Settings", icon: Settings, href: "/settings" }],
  },
  {
    title: "Learn",
    items: [{ label: "Guide", icon: BookOpen, href: "/guide" }],
  },
];

const Logo = () => (
  <div className="flex aspect-square size-8 items-center justify-center rounded-sm bg-primary text-primary-foreground">
    <Sparkle className="size-5" />
  </div>
);

const SidebarLogo = () => {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" tooltip="Sally" asChild>
          <a href="/attention" onClick={followLink}>
            <Logo />
            <div className="flex flex-col gap-0.5 leading-none">
              <span className="font-medium">Sally</span>
              <span className="text-xs text-muted-foreground">
                Salience engine
              </span>
            </div>
          </a>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};

const NavMenuItem = ({ item, path }: { item: NavItem; path: string }) => {
  const Icon = item.icon;
  const isActive = path === item.href || path.startsWith(item.href + "/");
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
        <a href={item.href} onClick={followLink}>
          <Icon className="size-4" />
          <span>{item.label}</span>
        </a>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};

/** A rules file named by its folder and file name; the full path is in the tooltip. */
const shortPath = (path: string) => path.split(/[\\/]/).filter(Boolean).slice(-2).join("/");

/**
 * The imports with a passage still pending, each with how many. Read again on
 * every move between screens and after every decision.
 */
function usePendingImports(path: string): ImportSummary[] {
  const [imports, setImports] = React.useState<ImportSummary[]>([]);
  const [changes, setChanges] = React.useState(0);
  React.useEffect(() => {
    const onChange = () => setChanges((n) => n + 1);
    window.addEventListener(IMPORTS_CHANGED, onChange);
    return () => window.removeEventListener(IMPORTS_CHANGED, onChange);
  }, []);
  React.useEffect(() => {
    let stale = false;
    listImports()
      .then((all) => !stale && setImports(all.filter((i) => i.pendingCount > 0)))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [path, changes]);
  return imports;
}

const ImportsGroup = ({ path }: { path: string }) => {
  const imports = usePendingImports(path);
  if (imports.length === 0) return null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>To review</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {imports.map((item) => {
            const href = `/imports/${item.id}`;
            const label = `Import ${shortPath(item.rulesFile)}`;
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  asChild
                  isActive={path === href || path.startsWith(href + "/")}
                  tooltip={`Import of ${item.rulesFile}: ${item.pendingCount} to review`}
                >
                  <a href={href} onClick={followLink} title={item.rulesFile}>
                    <FileInput className="size-4" />
                    <span className="truncate">{label}</span>
                  </a>
                </SidebarMenuButton>
                <SidebarMenuBadge aria-label={`${item.pendingCount} to review`}>{item.pendingCount}</SidebarMenuBadge>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
};

const AppSidebar = ({
  path,
  ...props
}: React.ComponentProps<typeof Sidebar> & { path: string }) => {
  return (
    <Sidebar variant="inset" collapsible="icon" {...props}>
      <SidebarHeader>
        <div className="flex items-center gap-2 group-data-[collapsible=icon]:flex-col">
          <SidebarLogo />
          <SidebarTrigger className="ml-auto group-data-[collapsible=icon]:ml-0" />
        </div>
      </SidebarHeader>
      <SidebarContent className="overflow-hidden">
        <ScrollArea className="min-h-0 flex-1">
          <ImportsGroup path={path} />
          {navGroups.map((group) => (
            <SidebarGroup key={group.title}>
              <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <NavMenuItem key={item.label} item={item} path={path} />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </ScrollArea>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
};

interface AppShellProps {
  path: string;
  className?: string;
  children: React.ReactNode;
}

export function AppShell({ path, className, children }: AppShellProps) {
  return (
    <SidebarProvider className={cn(className)}>
      <AppSidebar path={path} />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4 md:hidden">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-2 data-[orientation=vertical]:h-4"
          />
          <a href="/attention" onClick={followLink} className="flex items-center gap-2">
            <Logo />
            <span className="font-semibold">Sally</span>
          </a>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
