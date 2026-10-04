import { motion } from "framer-motion";
import { cn } from "./utils";

interface Column<T> {
  key: keyof T | string;
  header: string;
  render?: (row: T) => React.ReactNode;
  className?: string;
  align?: "left" | "center" | "right";
}

interface DataGridProps<T> {
  columns: Column<T>[];
  data: T[];
  onRowClick?: (row: T, index: number) => void;
  className?: string;
  rowClassName?: (row: T, index: number) => string | undefined;
  loading?: boolean;
  emptyMessage?: string;
}

export function DataGrid<T extends object>({
  columns,
  data,
  onRowClick,
  className,
  rowClassName,
  loading = false,
  emptyMessage = "No data",
}: DataGridProps<T>) {
  if (loading) {
    return (
      <div className={cn("rounded-xl border border-border bg-surface-50", className)}>
        <div className="p-6">
          <div className="mb-4 flex gap-4">
            {columns.map((col, i) => (
              <div key={i} className="h-4 animate-pulse rounded bg-surface-200 flex-1" style={{ maxWidth: '200px' }} />
            ))}
          </div>
          {Array.from({ length: 5 }).map((_, rowIdx) => (
            <div key={rowIdx} className="mb-2 flex gap-4">
              {columns.map((col, colIdx) => (
                <div key={colIdx} className="h-10 animate-pulse rounded bg-surface-100 flex-1" />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className={cn("rounded-xl border border-border bg-surface-50 p-12 text-center", className)}>
        <p className="text-text-tertiary">{emptyMessage}</p>
      </div>
    );
  }

  const getCellValue = (row: T, key: string): React.ReactNode => {
    const value = row[key as keyof T];
    return typeof value === "object" && value !== null ? "" : String(value ?? "");
  };

  return (
    <div className={cn("rounded-xl border border-border bg-surface-50 overflow-hidden", className)}>
      {/* Header */}
      <div className="border-b border-border bg-surface-100">
        <div className="flex">
          {columns.map((col, i) => (
            <div
              key={i}
              className={cn(
                "flex-1 px-6 py-4 text-xs font-medium uppercase tracking-wider text-text-secondary",
                col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left",
                col.className
              )}
            >
              {col.header}
            </div>
          ))}
        </div>
      </div>

      {/* Rows */}
      <div className="divide-y divide-border">
        {data.map((row, rowIdx) => (
          <motion.div
            key={rowIdx}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: rowIdx * 0.02 }}
            onClick={() => onRowClick?.(row, rowIdx)}
            className={cn(
              "flex transition-colors duration-150",
              onRowClick && "cursor-pointer hover:bg-surface-100",
              rowClassName?.(row, rowIdx)
            )}
          >
            {columns.map((col, colIdx) => (
              <div
                key={colIdx}
                className={cn(
                  "flex-1 px-6 py-4 text-sm",
                  col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left",
                  col.className
                )}
              >
                {col.render
                  ? col.render(row)
                  : getCellValue(row, col.key as string)}
              </div>
            ))}
          </motion.div>
        ))}
      </div>
    </div>
  );
}
