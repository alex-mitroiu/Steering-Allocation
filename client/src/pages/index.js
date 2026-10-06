// Route → page. The side menu shows only routes registered here.
import RoutingGuide from "./RoutingGuide.jsx";
import Ledger from "./Ledger.jsx";
import Contracts from "./Contracts.jsx";
import { MDM_ROUTES, mdmPage, Locations, Finance, MdmRedirect } from "./MasterData.jsx";
import Users from "./Users.jsx";
import Ranking from "./Ranking.jsx";
import Dashboard from "./Dashboard.jsx";
import { Cw1Report, NyshexReport, DataSources } from "./Imports.jsx";
import { AuditLog, Backups } from "./Admin.jsx";
import { useEffect } from "react";
import { go } from "../ctx.js";

function GuideRedirect() {
  useEffect(() => { go("guide"); }, []);
  return null;
}

export const PAGES = {
  guide: RoutingGuide,
  // Space Configurations became the Routing Guide; old links land there.
  space: GuideRedirect,
  ledger: Ledger,
  contracts: Contracts,
  mdm: MdmRedirect,
  ...Object.fromEntries(Object.entries(MDM_ROUTES).map(([path, kind]) => [path, mdmPage(kind)])),
  "mdm-locations": Locations,
  "mdm-finance": Finance,
  users: Users,
  ranking: Ranking,
  dashboard: Dashboard,
  cw1: Cw1Report,
  nyshex: NyshexReport,
  sources: DataSources,
  audit: AuditLog,
  backups: Backups,
};
