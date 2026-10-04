/**
 * UI Component Library
 *
 * shadcn/ui-inspired components with Robinhood/Lighter aesthetic.
 * Dark mode first, subtle gradients, smooth animations.
 */

/* Barrel-файл по определению экспортирует не только компоненты (тут и утилита cn),
 * поэтому правило react-refresh для него отключено — это ре-экспорт, не компонент. */
/* eslint-disable react-refresh/only-export-components */

// Utilities
export { cn } from "./utils";

// Card components
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "./card";

// Skeleton loaders
export { Skeleton, SkeletonText, SkeletonCard, SkeletonTable } from "./skeleton";

// Data display
export { DataGrid } from "./data-grid";

// Charts
export { ChartContainer, PriceChart, PortfolioBarChart } from "./chart-container";

// Actions
export { Button, Badge } from "./button";
