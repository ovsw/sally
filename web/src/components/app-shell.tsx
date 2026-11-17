// Adapted from the shadcnblocks block application-shell2 (inset sidebar with
// icon collapse).
import { Activity, ListChecks, Sparkle } from "lucide-react";
import type * as React from "react";
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
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
      { label: "Rules", icon: ListChecks, href: "/rules" },
      { label: "Activity", icon: Activity, href: "/activity" },
    ],
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
          <a href="/rules" onClick={followLink}>
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
          <a href="/rules" onClick={followLink} className="flex items-center gap-2">
            <Logo />
            <span className="font-semibold">Sally</span>
          </a>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
