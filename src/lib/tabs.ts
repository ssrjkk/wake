import {
  Bot,
  ChartCandlestick,
  Coins,
  Compass,
  LayoutDashboard,
  Repeat,
  ShieldAlert,
  Target,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { Tab } from "../components/types";

// Разделы приложения в том порядке, в каком они стоят на экране. Список один на
// всё приложение: он задаёт и порядок вкладок навигации, и номера горячих клавиш
// (Alt+1 … Alt+9), и то, какие значения принимает ?tab= в ссылке из Telegram-бота.
// Раздельные копии разъехались бы молча: переключатель есть, а клавиша свободна,
// или бот отдаёт ссылку на раздел, который оболочка не знает.
export interface TabDescriptor {
  id: Tab;
  label: string;
  icon: LucideIcon;
  // Панель читает публичный API Lighter и обновляется без бэкенда Wake.
  live?: boolean;
}

export const TABS: readonly TabDescriptor[] = [
  { id: "dashboard", label: "Обзор", icon: LayoutDashboard, live: true },
  { id: "terminal", label: "Терминал", icon: ChartCandlestick, live: true },
  { id: "discover", label: "Discover", icon: Compass },
  { id: "portfolio", label: "Портфель", icon: Wallet },
  { id: "earn", label: "Earn", icon: Coins },
  { id: "predict", label: "Predict", icon: Target },
  { id: "agent", label: "Агент", icon: Bot },
  { id: "risk", label: "Risk", icon: ShieldAlert },
  { id: "funding", label: "Funding", icon: Repeat },
];

export const TAB_IDS: readonly Tab[] = TABS.map((t) => t.id);
