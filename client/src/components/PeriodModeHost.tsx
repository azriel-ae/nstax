import { Fragment, useState, type ReactNode } from "react";
import type { Period } from "@/components/MonthlyUploadParts";

export type PeriodModeProps = {
  period: Period;
  onPeriod: (period: Period) => void;
  /** Mode harian menerima tepat 1 file; bila beberapa file dipilih, file dialihkan ke mode bulanan. */
  onMultiple: (files: File[]) => void;
  /** File yang dialihkan dari mode harian; diproses sekali saat mode bulanan dibuka. */
  initialFiles: File[];
};

/**
 * Pembungkus mode Harian (1 file) / Bulanan (banyak file). Setiap mode dirender sebagai instance terpisah (key = mode),
 * sehingga daftar file, hasil, dan filter tidak pernah tercampur antar mode. Parser dan perhitungan tidak disentuh.
 */
export default function PeriodModeHost({ render }: { render: (props: PeriodModeProps) => ReactNode }) {
  const [period, setPeriod] = useState<Period>("daily");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const onMultiple = (files: File[]) => { setPendingFiles(files); setPeriod("monthly"); };
  const onPeriod = (next: Period) => { if (next === "daily") setPendingFiles([]); setPeriod(next); };
  return <Fragment key={period}>{render({ period, onPeriod, onMultiple, initialFiles: period === "monthly" ? pendingFiles : [] })}</Fragment>;
}
