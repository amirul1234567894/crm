"use client";

import { createContext, useContext } from "react";

export interface OrgInfo {
  orgId: string;
  name: string;
  slug: string;
  role: "owner" | "manager" | "agent";
  userId: string;
  isSuperadmin: boolean;
  status: string;
}

const Ctx = createContext<OrgInfo | null>(null);

export function OrgProvider({ value, children }: { value: OrgInfo; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOrg(): OrgInfo {
  const v = useContext(Ctx);
  if (!v) throw new Error("useOrg must be used inside OrgProvider");
  return v;
}
