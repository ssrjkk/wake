import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import { motion } from "framer-motion";
import { cn } from "./utils";

interface ChartContainerProps {
  children: React.ReactNode;
  className?: string;
  title?: string;
  height?: number;
  loading?: boolean;
}

export function ChartContainer({
  children,
  className,
  title,
  height = 300,
  loading = false,
}: ChartContainerProps) {
  if (loading) {
    return (
      <div className={cn("rounded-xl border border-border bg-surface-50 p-6", className)}>
        {title && <div className="mb-4 h-6 w-32 animate-pulse rounded bg-surface-200" />}
        <div className="animate-pulse" style={{ height }}>
          <div className="h-full w-full rounded-lg bg-surface-100" />
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("rounded-xl border border-border bg-surface-50 p-6", className)}
    >
      {title && (
        <h3 className="mb-4 text-sm font-semibold text-text-primary">{title}</h3>
      )}
      <div style={{ height }}>
        {children}
      </div>
    </motion.div>
  );
}

interface PriceChartProps {
  data: Array<{ time: string; price: number; volume?: number }>;
  height?: number;
  className?: string;
}

export function PriceChart({ data, height = 250 }: PriceChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#ff6b35" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#ff6b35" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255, 255, 255, 0.08)" />
        <XAxis
          dataKey="time"
          stroke="#666666"
          fontSize={12}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          stroke="#666666"
          fontSize={12}
          tickLine={false}
          axisLine={false}
          domain={["auto", "auto"]}
          tickFormatter={(value: number) => `$${value.toLocaleString()}`}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "#1a1a1a",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            borderRadius: "8px",
            color: "#ffffff",
          }}
          labelStyle={{ color: "#a3a3a3" }}
          formatter={(value: number) => [`$${value.toLocaleString()}`, "Price"]}
        />
        <Area
          type="monotone"
          dataKey="price"
          stroke="#ff6b35"
          strokeWidth={2}
          fill="url(#priceGradient)"
          animationDuration={800}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

interface PortfolioChartProps {
  data: Array<{ asset: string; value: number; change: number }>;
  height?: number;
  className?: string;
}

export function PortfolioBarChart({ data, height = 250 }: PortfolioChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255, 255, 255, 0.08)" />
        <XAxis
          dataKey="asset"
          stroke="#666666"
          fontSize={12}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          stroke="#666666"
          fontSize={12}
          tickLine={false}
          axisLine={false}
          domain={["auto", "auto"]}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "#1a1a1a",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            borderRadius: "8px",
            color: "#ffffff",
          }}
        />
        <Bar
          dataKey="value"
          fill="#ff6b35"
          radius={[4, 4, 0, 0]}
          animationDuration={800}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
