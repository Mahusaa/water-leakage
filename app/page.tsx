"use client";

import { useEffect, useMemo, useState, type ElementType } from "react";
import { ref, onValue } from "firebase/database";
import {
  Activity,
  GaugeCircle,
  History,
  Home,
  RefreshCw,
  Settings,
} from "lucide-react";
import { db } from "../lib/firebaseClient";

type SensorData = {
  flow: string;
  total: string;
  timestamp: number;
  r_value?: number;
  threshold?: number;
};

type Sensors = {
  [key: string]: SensorData;
};

type HistoryEntry = SensorData & {
  sensorId: string;
};

type ChartDataPoint = {
  timestamp: number;
  flowrate: number;
  timeLabel: string;
};

type SensorChartData = {
  data: ChartDataPoint[];
  color: string;
  sensorId: string;
};

type NavKey = "home" | "realtime" | "history" | "settings";
type HistoryFilter = "today" | "7d" | "all";

// Chart configuration
const CHART_WINDOW_SIZE = 100; // Keep last 100 data points
const SENSOR_CARD_CHART_COLOR = "#34d399"; // Green for all sensor cards

const navItems: { key: NavKey; label: string; icon: ElementType }[] = [
  { key: "home", label: "Home", icon: Home },
  { key: "realtime", label: "Realtime Data", icon: Activity },
  { key: "history", label: "History", icon: History },
  { key: "settings", label: "Settings", icon: Settings },
];

// Hero visual configuration (easy to tweak)
const HERO_BACKGROUND_IMAGE = "/musholla-hero.jpg"; // place image in /public
const HERO_STYLES = {
  overlay: "bg-slate-950/70", // overall darkness
  blur: "blur-sm md:blur-[3px]", // image blur intensity
} as const;

const normalizeSensors = (data: unknown): Sensors => {
  if (!data || typeof data !== "object") {
    return {};
  }

  const parseOptionalNumber = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };

  return Object.entries(data as Record<string, Partial<SensorData>>).reduce(
    (acc, [key, value]) => {
      if (
        typeof value?.flow === "string" &&
        typeof value?.total === "string" &&
        typeof value?.timestamp === "number"
      ) {
        acc[key] = {
          flow: value.flow,
          total: value.total,
          timestamp: value.timestamp,
          r_value: parseOptionalNumber(value.r_value),
          threshold: parseOptionalNumber(value.threshold),
        };
      } else {
        // Log missing/invalid sensor data for debugging
        console.warn(`Sensor ${key} has invalid or missing data:`, value);
      }
      return acc;
    },
    {} as Sensors
  );
};

const normalizeHistory = (data: unknown): HistoryEntry[] => {
  if (!data || typeof data !== "object") {
    return [];
  }

  const entries: HistoryEntry[] = [];
  Object.entries(data as Record<string, Record<string, Partial<SensorData>>>).forEach(
    ([sensorId, sensorHistory]) => {
      if (sensorHistory && typeof sensorHistory === "object") {
        Object.entries(sensorHistory).forEach(([, entry]) => {
          if (
            typeof entry?.flow === "string" &&
            typeof entry?.total === "string" &&
            typeof entry?.timestamp === "number"
          ) {
            entries.push({
              sensorId,
              flow: entry.flow,
              total: entry.total,
              timestamp: entry.timestamp,
            });
          }
        });
      }
    }
  );

  return entries.sort((a, b) => b.timestamp - a.timestamp);
};

const formatTimestamp = (timestamp: number) => {
  if (!timestamp) return "-";
  return new Date(timestamp * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
};

const parseMetric = (value: string) => {
  if (!value) return 0;
  const numeric = parseFloat(value.replace(/[^\d.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
};

const formatOptionalNumber = (value?: number) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toFixed(3);
  }
  return "-";
};

/**
 * Detects if there is a leakage issue based on global r_value and threshold.
 * 
 * @param globalRValue - Global r_value from Firebase
 * @param globalThreshold - Global threshold from Firebase
 * @returns true if leakage is detected (r_value > threshold), false otherwise
 */
const isLeakageDetected = (globalRValue?: number, globalThreshold?: number): boolean => {
  if (globalRValue === undefined || globalThreshold === undefined) {
    return false;
  }

  if (!Number.isFinite(globalRValue) || !Number.isFinite(globalThreshold)) {
    return false;
  }

  return globalRValue > globalThreshold;
};

const buildSparklinePath = (values: number[], width = 160, height = 60) => {
  if (!values.length) return "";
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const step = width / Math.max(values.length - 1, 1);
  return values
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / range) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
};

// Live Chart Component for real-time flowrate visualization
const LiveChart = ({ sensorId, data, color, compact = false }: SensorChartData & { compact?: boolean }) => {
  const chartWidth = compact ? 400 : 800;
  const chartHeight = compact ? 120 : 200;
  const padding = compact ? { top: 10, right: 10, bottom: 25, left: 40 } : { top: 20, right: 20, bottom: 40, left: 60 };

  if (!data || data.length === 0) {
    return (
      <div className={`rounded-2xl border border-slate-800 bg-slate-900/70 ${compact ? "p-3" : "p-8"} text-center`}>
        <p className="text-slate-400 text-sm">No data yet</p>
      </div>
    );
  }

  const flowValues = data.map((d) => d.flowrate);
  const maxFlow = Math.max(...flowValues, 0.001);
  const minFlow = Math.min(...flowValues, 0);
  const flowRange = maxFlow - minFlow || 0.001;

  const plotWidth = chartWidth - padding.left - padding.right;
  const plotHeight = chartHeight - padding.top - padding.bottom;

  // Build path for the line chart
  const pathData = data
    .map((point, index) => {
      const x = padding.left + (index / Math.max(data.length - 1, 1)) * plotWidth;
      const y =
        padding.top +
        plotHeight -
        ((point.flowrate - minFlow) / flowRange) * plotHeight;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  // Get latest value for display
  const latestPoint = data[data.length - 1];

  return (
    <div className={`rounded-2xl border border-slate-800 bg-slate-900/70 ${compact ? "p-3" : "p-6"}`}>
      {!compact && (
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold capitalize">{sensorId}</h3>
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/40 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-200">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Live
            </span>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-500">Current Flowrate</p>
            <p className="text-xl font-semibold" style={{ color }}>
              {latestPoint.flowrate.toFixed(3)} L/min
            </p>
          </div>
        </div>
      )}

      <div className="relative">
        <svg
          width={chartWidth}
          height={chartHeight}
          className="w-full h-auto"
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        >
          <defs>
            <linearGradient id={`gradient-${sensorId}`} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor={color} stopOpacity="0.8" />
              <stop offset="100%" stopColor={color} stopOpacity="0.1" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = padding.top + plotHeight - ratio * plotHeight;
            return (
              <line
                key={ratio}
                x1={padding.left}
                y1={y}
                x2={chartWidth - padding.right}
                y2={y}
                stroke="rgba(148, 163, 184, 0.1)"
                strokeWidth="1"
              />
            );
          })}

          {/* Y-axis labels */}
          {!compact && [0, 0.5, 1].map((ratio) => {
            const value = minFlow + (maxFlow - minFlow) * (1 - ratio);
            const y = padding.top + ratio * plotHeight;
            return (
              <text
                key={ratio}
                x={padding.left - 10}
                y={y + 4}
                textAnchor="end"
                className="text-xs fill-slate-500"
              >
                {value.toFixed(3)}
              </text>
            );
          })}

          {/* Area under curve */}
          {data.length > 1 && (
            <path
              d={`${pathData} L ${padding.left + plotWidth} ${padding.top + plotHeight} L ${padding.left} ${padding.top + plotHeight} Z`}
              fill={`url(#gradient-${sensorId})`}
              className="transition-all duration-300"
            />
          )}

          {/* Line */}
          <path
            d={pathData}
            fill="none"
            stroke={color}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="transition-all duration-300"
          />

          {/* Latest point indicator */}
          {latestPoint && (
            <circle
              cx={padding.left + plotWidth}
              cy={
                padding.top +
                plotHeight -
                ((latestPoint.flowrate - minFlow) / flowRange) * plotHeight
              }
              r="4"
              fill={color}
              className="animate-pulse"
            />
          )}
        </svg>
      </div>

      {/* Time labels */}
      {!compact && (
        <div className="flex justify-between mt-2 text-xs text-slate-500">
          <span>
            {data.length > 0 ? data[0].timeLabel : "-"}
          </span>
          <span>
            {data.length > 0 ? data[data.length - 1].timeLabel : "-"}
          </span>
        </div>
      )}
    </div>
  );
};

export default function HomePage() {
  const [sensors, setSensors] = useState<Sensors>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<NavKey>("home");
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const [toggles, setToggles] = useState({
    autoRefresh: true,
    alerts: true,
    ecoMode: false,
  });
  // Global r_value and threshold (fetched from /system paths)
  const [globalRValue, setGlobalRValue] = useState<number | undefined>(undefined);
  const [globalThreshold, setGlobalThreshold] = useState<number | undefined>(undefined);
  const [systemError, setSystemError] = useState<string | null>(null);
  // Chart data for each sensor (rolling window)
  const [chartData, setChartData] = useState<Record<string, ChartDataPoint[]>>({
    sensor1: [],
    sensor2: [],
    sensor3: [],
    sensor4: [],
  });

  // Fetch global r_value, threshold, and status from Firebase /system paths with realtime listeners
  useEffect(() => {
    const unsubscribes: (() => void)[] = [];

    // Subscribe to /system/r_value
    const rValueRef = ref(db, "system/r_value");
    console.log("[Realtime] Subscribing to /system/r_value");
    const unsubscribeRValue = onValue(
      rValueRef,
      (snapshot) => {
        try {
          const value = snapshot.val();
          if (value !== null && value !== undefined) {
            const numValue = typeof value === "number" ? value : parseFloat(value);
            if (Number.isFinite(numValue)) {
              setGlobalRValue(numValue);
              setSystemError(null);
              console.log(`[Realtime] Updated r_value: ${numValue}`);
            } else {
              console.warn(`[Realtime] Invalid r_value format: ${value}`);
            }
          } else {
            console.warn("[Realtime] /system/r_value is null or missing");
            setSystemError("System r_value not available");
          }
        } catch (err) {
          console.error("[Realtime] Failed to parse r_value:", err);
          setSystemError("Failed to parse r_value");
        }
      },
      (err) => {
        const error = err as Error & { code?: string };
        console.error("[Realtime] Error subscribing to /system/r_value:", error);
        if (error.code === "PERMISSION_DENIED") {
          setSystemError("Permission denied: /system/r_value");
        } else {
          setSystemError("Failed to connect to /system/r_value");
        }
      }
    );
    unsubscribes.push(unsubscribeRValue);

    // Subscribe to /system/threshold
    const thresholdRef = ref(db, "system/threshold");
    console.log("[Realtime] Subscribing to /system/threshold");
    const unsubscribeThreshold = onValue(
      thresholdRef,
      (snapshot) => {
        try {
          const value = snapshot.val();
          if (value !== null && value !== undefined) {
            const numValue = typeof value === "number" ? value : parseFloat(value);
            if (Number.isFinite(numValue)) {
              setGlobalThreshold(numValue);
              setSystemError(null);
              console.log(`[Realtime] Updated threshold: ${numValue}`);
            } else {
              console.warn(`[Realtime] Invalid threshold format: ${value}`);
            }
          } else {
            console.warn("[Realtime] /system/threshold is null or missing");
            setSystemError("System threshold not available");
          }
        } catch (err) {
          console.error("[Realtime] Failed to parse threshold:", err);
          setSystemError("Failed to parse threshold");
        }
      },
      (err) => {
        const error = err as Error & { code?: string };
        console.error("[Realtime] Error subscribing to /system/threshold:", error);
        if (error.code === "PERMISSION_DENIED") {
          setSystemError("Permission denied: /system/threshold");
        } else {
          setSystemError("Failed to connect to /system/threshold");
        }
      }
    );
    unsubscribes.push(unsubscribeThreshold);

    return () => {
      unsubscribes.forEach((unsub) => unsub());
    };
  }, []);

  // Real-time sensor data from sensorsCurrent/ (with fallback to root /)
  useEffect(() => {
    const tryPaths = ["sensorsCurrent", "/"];
    let unsubscribe: (() => void) | null = null;

    const subscribeToPath = (pathIndex: number) => {
      if (pathIndex >= tryPaths.length) {
        console.error("Failed to connect to any Firebase path");
        setError("Tidak dapat terhubung ke Firebase. Periksa konfigurasi.");
        setLoading(false);
        return;
      }

      const path = tryPaths[pathIndex];
      const sensorsRef = ref(db, path);

      unsubscribe = onValue(
        sensorsRef,
        (snapshot) => {
          try {
            const data = snapshot.val();
            if (data) {
              const normalized = normalizeSensors(data);
              setSensors(normalized);
              setError(null);
              console.log(`Connected to Firebase path: ${path}, discovered ${Object.keys(normalized).length} sensors`);
            } else if (pathIndex < tryPaths.length - 1) {
              // Try next path if current one is empty
              console.warn(`Path ${path} returned null, trying fallback...`);
              subscribeToPath(pathIndex + 1);
              return;
            } else {
              console.warn(`No sensor data found at ${path}`);
              setSensors({});
            }
          } catch (err) {
            console.error("Failed to parse sensor data", err);
            if (pathIndex < tryPaths.length - 1) {
              subscribeToPath(pathIndex + 1);
              return;
            }
            setError("Tidak dapat memuat data sensor.");
          } finally {
            setLoading(false);
          }
        },
        (err) => {
          console.error(`Firebase subscription error for path ${path}:`, err);
          if (pathIndex < tryPaths.length - 1) {
            subscribeToPath(pathIndex + 1);
          } else {
            setError("Koneksi Firebase bermasalah.");
            setLoading(false);
          }
        }
      );
    };

    subscribeToPath(0);

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  // History data from sensorsHistory/
  useEffect(() => {
    if (activeSection !== "history") return;

    setHistoryLoading(true);
    const historyRef = ref(db, "sensorsHistory");

    const unsubscribe = onValue(
      historyRef,
      (snapshot) => {
        try {
          const data = snapshot.val();
          const normalized = normalizeHistory(data);
          setHistory(normalized);
          console.log(`Loaded ${normalized.length} history entries`);
        } catch (err) {
          console.error("Failed to parse history data", err);
        } finally {
          setHistoryLoading(false);
        }
      },
      (err) => {
        console.error("Firebase history subscription error", err);
        setHistoryLoading(false);
      }
    );

    return () => unsubscribe();
  }, [activeSection]);

  // Real-time flowrate listeners for sensor1-4 charts
  useEffect(() => {
    const sensorIds = ["sensor1", "sensor2", "sensor3", "sensor4"];
    const unsubscribes: (() => void)[] = [];

    sensorIds.forEach((sensorId) => {
      // Try sensorsCurrent path first, then root
      const tryPaths = [`sensorsCurrent/${sensorId}`, `/${sensorId}`];

      const subscribeToPath = (pathIndex: number) => {
        if (pathIndex >= tryPaths.length) {
          console.warn(`No data path found for ${sensorId}`);
          return;
        }

        const path = tryPaths[pathIndex];
        const sensorRef = ref(db, path);

        const unsubscribe = onValue(
          sensorRef,
          (snapshot) => {
            try {
              const data = snapshot.val();
              if (data && data.flow && typeof data.timestamp === "number") {
                const flowValue = parseMetric(data.flow);
                const timestamp = data.timestamp;
                const timeLabel = new Date(timestamp * 1000).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                });

                setChartData((prev) => {
                  const currentData = prev[sensorId] || [];
                  const newDataPoint: ChartDataPoint = {
                    timestamp,
                    flowrate: flowValue,
                    timeLabel,
                  };

                  // Add new point and maintain rolling window
                  const updated = [...currentData, newDataPoint];
                  if (updated.length > CHART_WINDOW_SIZE) {
                    updated.shift(); // Remove oldest point
                  }

                  return {
                    ...prev,
                    [sensorId]: updated,
                  };
                });
              } else if (pathIndex < tryPaths.length - 1) {
                // Try next path
                subscribeToPath(pathIndex + 1);
              }
            } catch (err) {
              console.error(`Error processing chart data for ${sensorId}:`, err);
            }
          },
          (err) => {
            console.error(`Firebase chart subscription error for ${sensorId}:`, err);
            if (pathIndex < tryPaths.length - 1) {
              subscribeToPath(pathIndex + 1);
            }
          }
        );

        unsubscribes.push(unsubscribe);
      };

      subscribeToPath(0);
    });

    return () => {
      unsubscribes.forEach((unsub) => unsub());
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000 * 30);
    return () => clearInterval(timer);
  }, []);

  const greeting = useMemo(() => {
    const hour = currentTime.getHours();
    if (hour < 12) return "Good Morning!";
    if (hour < 18) return "Good Afternoon!";
    return "Good Evening!";
  }, [currentTime]);

  const formattedTime = useMemo(
    () =>
      currentTime.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    [currentTime]
  );

  const formattedDate = useMemo(
    () =>
      currentTime.toLocaleDateString(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
    [currentTime]
  );

  const sensorEntries = useMemo(() => {
    // Auto-discover all sensors by iterating keys, sorted alphabetically
    return Object.entries(sensors).sort(([a], [b]) => a.localeCompare(b));
  }, [sensors]);

  const filteredHistory = useMemo(() => {
    if (!history.length) return [];

    const now = Date.now() / 1000;
    const filterMap: Record<HistoryFilter, number> = {
      today: 24 * 60 * 60, // 24 hours
      "7d": 7 * 24 * 60 * 60, // 7 days
      all: Infinity,
    };

    const cutoff = now - filterMap[historyFilter];
    return history.filter((entry) => entry.timestamp >= cutoff);
  }, [history, historyFilter]);

  const leakageStatus = useMemo(() => {
    const hasLeakage = isLeakageDetected(globalRValue, globalThreshold);
    
    return {
      hasLeakage,
      message: hasLeakage ? "Leakage detected" : "Tidak ada kebocoran terdeteksi",
    };
  }, [globalRValue, globalThreshold]);

  const summary = useMemo(() => {
    if (!sensorEntries.length) {
      return {
        totalVolume: "0.000 L",
        latestUpdate: "-",
      };
    }

    const total = sensorEntries.reduce(
      (acc, [, sensor]) => acc + parseMetric(sensor.total),
      0
    );
    const latestTimestamp = Math.max(
      ...sensorEntries.map(([, sensor]) => sensor.timestamp || 0)
    );

    return {
      totalVolume: `${total.toFixed(3)} L`,
      latestUpdate: formatTimestamp(latestTimestamp),
    };
  }, [sensorEntries]);

  const toggleSetting = (key: keyof typeof toggles) => {
    setToggles((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const sensorGrid = sensorEntries.length ? (
    <section className="grid gap-5 sm:grid-cols-2 2xl:grid-cols-3">
      {sensorEntries
        .filter(([, sensor]) => {
          // Filter out sensors with incomplete data
          if (!sensor || !sensor.flow || !sensor.total || !sensor.timestamp) {
            console.warn(`Sensor data incomplete, skipping display:`, sensor);
            return false;
          }
          return true;
        })
        .map(([key, sensor]) => {
        // Check if this is sensor1-4 for live chart
        const isSensor1to4 = ["sensor1", "sensor2", "sensor3", "sensor4"].includes(key.toLowerCase());

        return (
          <article
            key={key}
            className="rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-900/80 via-slate-900/60 to-slate-900/20 p-6 shadow-[0_20px_60px_rgba(8,8,16,0.5)] transition-all duration-300 hover:-translate-y-1 hover:border-indigo-400/70"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
                  Sensor
                </p>
                <h2 className="text-xl font-semibold">{key}</h2>
              </div>
              <span className="inline-flex items-center gap-2 rounded-full border border-indigo-300/40 bg-indigo-500/10 px-3 py-1 text-xs font-semibold text-indigo-200">
                <span className="h-2 w-2 rounded-full bg-indigo-400 animate-pulse" />
                Live
              </span>
            </div>

            <dl className="mt-6 space-y-4 text-sm">
              <div className="flex items-baseline justify-between">
                <dt className="text-slate-400">Flow rate</dt>
                <dd className="text-2xl font-semibold text-slate-50">
                  {sensor.flow}
                </dd>
              </div>
              <div className="flex items-baseline justify-between sm:block">
                <dt className="text-slate-400">Total volume</dt>
                <dd className="text-xl font-semibold text-slate-100">
                  {sensor.total}
                </dd>
              </div>
            </dl>

            {/* Live flowrate chart for sensor1-4, fallback to placeholder for others */}
            <div className="mt-6">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500 mb-2">
                Flow trend
              </p>
              {isSensor1to4 ? (
                <LiveChart
                  sensorId={key}
                  data={chartData[key.toLowerCase()] || []}
                  color={SENSOR_CARD_CHART_COLOR}
                  compact={true}
                />
              ) : (
                <div className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-3 text-center">
                  <p className="text-xs text-slate-500">Chart available for sensor1-4</p>
                </div>
              )}
            </div>

          </article>
        );
      })}
    </section>
  ) : (
    <div className="rounded-3xl border border-dashed border-slate-700 bg-slate-900/40 p-10 text-center text-slate-400">
      Belum ada data sensor.
    </div>
  );

  const quickToggles = (
    <div className="grid gap-4 rounded-3xl border border-slate-800 bg-slate-900/60 p-6 sm:grid-cols-3">
      {[
        { key: "autoRefresh", label: "Auto Refresh" },
        { key: "alerts", label: "Send Alerts" },
        { key: "ecoMode", label: "Eco Mode" },
      ].map((toggle) => (
        <div
          key={toggle.key}
          className="flex items-center justify-between rounded-2xl border border-slate-800/60 bg-slate-900/70 px-4 py-3"
        >
          <span className="text-sm text-slate-300">{toggle.label}</span>
          <button
            type="button"
            onClick={() => toggleSetting(toggle.key as keyof typeof toggles)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
              toggles[toggle.key as keyof typeof toggles]
                ? "bg-indigo-500"
                : "bg-slate-600"
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                toggles[toggle.key as keyof typeof toggles]
                  ? "translate-x-5"
                  : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
      ))}
    </div>
  );

  const historyView = (
    <section className="space-y-6">
      {/* History filters */}
      <div className="flex flex-wrap gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-3">
        {(["today", "7d", "all"] as HistoryFilter[]).map((filter) => (
          <button
            key={filter}
            onClick={() => setHistoryFilter(filter)}
            className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
              historyFilter === filter
                ? "bg-indigo-500 text-white"
                : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            }`}
          >
            {filter === "today" ? "Today" : filter === "7d" ? "Last 7 Days" : "All Time"}
          </button>
        ))}
      </div>

      {historyLoading ? (
        <div className="rounded-3xl border border-slate-800 bg-slate-900/60 p-10 text-center text-slate-400">
          <p>Loading history data...</p>
        </div>
      ) : filteredHistory.length === 0 ? (
        <div className="rounded-3xl border border-slate-800 bg-slate-900/60 p-10 text-center text-slate-400">
          <p className="text-lg font-medium text-slate-200">No history data available</p>
          <p className="mt-2 text-sm text-slate-400">
            {history.length === 0
              ? "History data will appear here once sensors start recording."
              : `No entries found for ${historyFilter === "today" ? "today" : historyFilter === "7d" ? "the last 7 days" : "this period"}.`}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Group history by sensor */}
          {Array.from(new Set(filteredHistory.map((h) => h.sensorId)))
            .sort()
            .map((sensorId) => {
              const sensorHistory = filteredHistory.filter((h) => h.sensorId === sensorId);
              const latest = sensorHistory[0];
              const chartValues = sensorHistory
                .slice(0, 20)
                .reverse()
                .map((entry) => parseMetric(entry.flow));

              return (
                <article
                  key={sensorId}
                  className="rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-900/80 via-slate-900/60 to-slate-900/20 p-6 shadow-[0_20px_60px_rgba(8,8,16,0.5)]"
                >
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-xl font-semibold">{sensorId}</h3>
                    <span className="text-xs text-slate-500">
                      {sensorHistory.length} {sensorHistory.length === 1 ? "entry" : "entries"}
                    </span>
                  </div>

                  <div className="grid gap-4 md:grid-cols-3 mb-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-500 mb-1">
                        Latest Flow
                      </p>
                      <p className="text-lg font-semibold text-slate-50">{latest.flow}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-500 mb-1">
                        Latest Total
                      </p>
                      <p className="text-lg font-semibold text-slate-50">{latest.total}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-500 mb-1">
                        Last Update
                      </p>
                      <p className="text-sm font-semibold text-slate-300">
                        {formatTimestamp(latest.timestamp)}
                      </p>
                    </div>
                  </div>

                  {chartValues.length > 0 && (
                    <div className="mt-4">
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-500 mb-2">
                        Flow Trend ({historyFilter})
                      </p>
                      <div className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-3">
                        <svg
                          viewBox="0 0 160 60"
                          className="h-16 w-full text-indigo-300"
                          role="img"
                          aria-label={`History chart for ${sensorId}`}
                        >
                          <defs>
                            <linearGradient id={`hist-grad-${sensorId}`} x1="0%" y1="0%" x2="0%" y2="100%">
                              <stop offset="0%" stopColor="#818cf8" stopOpacity="0.9" />
                              <stop offset="100%" stopColor="#a5b4fc" stopOpacity="0.2" />
                            </linearGradient>
                          </defs>
                          <path
                            d={buildSparklinePath(chartValues, 160, 60)}
                            fill="none"
                            stroke={`url(#hist-grad-${sensorId})`}
                            strokeWidth="3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </div>
                    </div>
                  )}

                  <div className="mt-4 pt-4 border-t border-slate-800">
                    <p className="text-xs text-slate-500">
                      Showing {sensorHistory.length} of {history.filter((h) => h.sensorId === sensorId).length} total entries
                    </p>
                  </div>
                </article>
              );
            })}
        </div>
      )}
    </section>
  );

  const settingsPanel = (
    <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-8 space-y-6">
      <h3 className="text-xl font-semibold">Control Center</h3>
      <p className="text-sm text-slate-400">
        Sesuaikan perilaku dashboard tanpa meninggalkan layar ini.
      </p>
      {quickToggles}
      <button
        type="button"
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-indigo-500/90 py-3 text-sm font-semibold text-white transition hover:bg-indigo-400"
      >
        <RefreshCw className="h-4 w-4" />
        Apply configuration
      </button>
    </section>
  );

  // Status Panel Component (modular, receives sensors data)
  const StatusPanel = () => {
    if (!sensorEntries.length) {
      return (
        <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5">
          <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
            Status
          </p>
          <p className="mt-2 text-lg font-semibold text-slate-300">
            Data belum tersedia
          </p>
        </div>
      );
    }

    const hasLeakage = leakageStatus.hasLeakage;
    const hasSystemData = globalRValue !== undefined && globalThreshold !== undefined;

    return (
      <div className={`rounded-3xl border ${hasLeakage ? 'border-red-500/50' : 'border-slate-800'} bg-slate-900/70 p-5`}>
        <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
          Status
        </p>
        <div className="mt-3 space-y-2">
          {!hasSystemData ? (
            <p className="text-sm text-yellow-400">
              Waiting for system data...
            </p>
          ) : hasLeakage ? (
            <p className="text-lg font-semibold text-red-400">
              Leakage detected
            </p>
          ) : (
            <p className="text-lg font-semibold text-emerald-400">
              {leakageStatus.message}
            </p>
          )}
        </div>
      </div>
    );
  };

  const renderSection = () => {
    if (activeSection === "history") return historyView;
    if (activeSection === "settings") return settingsPanel;
    return (
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-3">
          <StatusPanel />
          <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5">
            <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
              Total Volume
            </p>
            <p className="mt-2 text-3xl font-semibold text-slate-50">
              {summary.totalVolume}
            </p>
          </div>
          <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5">
            <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
              Latest Update
            </p>
            {systemError ? (
              <div className="mt-3">
                <p className="text-sm text-yellow-400">{systemError}</p>
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                <div>
                  <p className="text-xs text-slate-400 mb-1">r_value</p>
                  <p className="text-lg font-semibold text-slate-50">
                    {formatOptionalNumber(globalRValue)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-400 mb-1">threshold</p>
                  <p className="text-lg font-semibold text-slate-50">
                    {formatOptionalNumber(globalThreshold)}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
        {sensorGrid}
        {quickToggles}
      </div>
    );
  };

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
        <p className="text-lg tracking-wide">Memuat data sensor...</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4 bg-slate-950 text-slate-100">
        <p className="text-center text-red-400 bg-red-400/10 border border-red-500/40 px-6 py-4 rounded-2xl">
          {error}
        </p>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 lg:flex">
      <aside className="hidden w-64 flex-col border-r border-slate-900/40 bg-slate-950/80 p-6 lg:flex">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl bg-indigo-500/20 p-3">
            <GaugeCircle className="h-6 w-6 text-indigo-300" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
              Sensor
            </p>
            <p className="text-lg font-semibold">Monitoring</p>
          </div>
        </div>

        <nav className="mt-10 space-y-2">
          {navItems.map(({ key, label, icon: Icon }) => {
            const isActive = activeSection === key;
            return (
              <button
                key={key}
                onClick={() => setActiveSection(key)}
                className={`flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium transition ${
                  isActive
                    ? "bg-indigo-500/20 text-white"
                    : "text-slate-400 hover:bg-slate-900"
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            );
          })}
        </nav>

        <div className="mt-auto rounded-3xl border border-slate-800 bg-slate-900/70 p-4 text-xs text-slate-400">
          Realtime feed connected to Firebase Realtime Database.
        </div>
      </aside>

      <div className="flex-1">
        <div className="border-b border-slate-900/40 px-5 py-4 lg:hidden">
          <div className="flex items-center justify-between">
            <p className="font-semibold">{greeting}</p>
            <div className="flex gap-2">
              {navItems.map(({ key, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setActiveSection(key)}
                  className={`rounded-full p-2 ${
                    activeSection === key
                      ? "bg-indigo-500/30 text-white"
                      : "text-slate-400"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </button>
              ))}
            </div>
          </div>
        </div>

        <main className="space-y-8 px-4 py-6 sm:px-6 lg:px-10">
          <header className="relative overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/90 p-8 text-white shadow-[0_25px_80px_rgba(5,5,15,0.6)]">
            {/* Background image only for hero section */}
            <div
              className="pointer-events-none absolute inset-0 scale-105 bg-cover bg-center"
              style={{ backgroundImage: `url(${HERO_BACKGROUND_IMAGE})` }}
              aria-hidden="true"
            />
            {/* Dark overlay + blur (tweak via HERO_STYLES) */}
            <div
              className={`pointer-events-none absolute inset-0 ${HERO_STYLES.overlay} ${HERO_STYLES.blur}`}
              aria-hidden="true"
            />

            <div className="relative z-10">
              <div className="flex flex-wrap items-start justify-between gap-6">
                <div>
                  <p className="text-sm uppercase tracking-[0.4em] text-indigo-200/80">
                    Smart dashboard
                  </p>
                  <h1 className="mt-3 text-3xl font-semibold md:text-4xl">
                    {greeting}
                  </h1>
                  <p className="mt-3 text-sm text-indigo-100/90">
                    Welcome to Sensor Monitoring Dashboard — track every drop
                    and keep your operations running smoothly.
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-3xl font-semibold">{formattedTime}</p>
                  <p className="text-sm text-indigo-100/80">{formattedDate}</p>
                </div>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                  <p className="text-xs uppercase text-indigo-100/70">
                    Active sensors
                  </p>
                  <p className="mt-2 text-3xl font-semibold">
                    {sensorEntries.length}
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                  <p className="text-xs uppercase text-indigo-100/70">
                    Last update
                  </p>
                  <p className="mt-2 text-lg font-semibold">
                    {summary.latestUpdate}
                  </p>
                </div>
              </div>
            </div>
          </header>

          {renderSection()}
        </main>
      </div>
    </div>
  );
}
