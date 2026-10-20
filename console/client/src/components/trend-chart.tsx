import * as React from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface TrendChartPoint {
  label: string;
  value: number;
  tooltip?: string;
}

interface TooltipPayloadEntry {
  payload: TrendChartPoint;
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
}): React.ReactElement | null {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-[13px] shadow-md">
      <div className="text-muted-foreground">
        {point.tooltip ?? point.label}
      </div>
      <div className="mt-0.5 font-medium tabular-nums">
        {point.value} drift {point.value === 1 ? "item" : "items"}
      </div>
    </div>
  );
}

export function TrendChart({
  points,
  height = 200,
  emptyText = "Nothing to chart yet.",
}: {
  points: TrendChartPoint[];
  height?: number;
  emptyText?: string;
}): React.ReactElement {
  const gradientId = React.useId();
  const hasData = points.some((point) => point.value > 0);
  if (points.length === 0 || !hasData) {
    return (
      <div
        className="flex items-center justify-center text-muted-foreground text-sm"
        style={{ height }}
      >
        {emptyText}
      </div>
    );
  }
  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer height="100%" width="100%">
        <AreaChart
          data={points}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--foreground)"
                stopOpacity={0.14}
              />
              <stop
                offset="100%"
                stopColor="var(--foreground)"
                stopOpacity={0.01}
              />
            </linearGradient>
          </defs>
          <CartesianGrid
            stroke="var(--border)"
            strokeDasharray="3 3"
            vertical={false}
          />
          <XAxis
            axisLine={false}
            dataKey="label"
            fontSize={12}
            interval="preserveStartEnd"
            minTickGap={28}
            stroke="var(--muted-foreground)"
            tickLine={false}
            tickMargin={8}
          />
          <YAxis
            allowDecimals={false}
            axisLine={false}
            fontSize={12}
            stroke="var(--muted-foreground)"
            tickLine={false}
            width={32}
          />
          <Tooltip
            content={<ChartTooltip />}
            cursor={{ stroke: "var(--border)" }}
          />
          <Area
            activeDot={{ r: 3 }}
            dataKey="value"
            dot={false}
            fill={`url(#${gradientId})`}
            stroke="var(--foreground)"
            strokeWidth={1.5}
            type="monotone"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
