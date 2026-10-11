import { useId, type ReactNode } from "react";

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  id,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  label?: string;
  id?: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label} id={id}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? "on" : ""}
          title={o.title}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
  format,
  id,
  center,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  id: string;
  /** Value the track fills from (0 for bipolar sliders). */
  center?: number;
}) {
  const c = center ?? min;
  const pct = (v: number) => ((v - min) / (max - min)) * 100;
  const a = Math.min(pct(value), pct(c));
  const b = Math.max(pct(value), pct(c));
  return (
    <label className="slider" htmlFor={id}>
      <span className="slider-head">
        <span>{label}</span>
        <span className="num">{format ? format(value) : value.toFixed(2)}</span>
      </span>
      <span className="slider-track" style={{ ["--a" as string]: `${a}%`, ["--b" as string]: `${b}%` }}>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          onDoubleClick={() => center !== undefined && onChange(center)}
        />
      </span>
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <label className="toggle" htmlFor={id}>
      <span className="toggle-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" aria-hidden="true" />
    </label>
  );
}

export function Field({ label, children, aside }: { label: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="field">
      <div className="field-head">
        <span className="eyebrow">{label}</span>
        {aside}
      </div>
      {children}
    </div>
  );
}

export function Meter({ value }: { value: number }) {
  return (
    <span className="meter" aria-label={`Quality ${Math.round(value * 100)} of 100`}>
      <span style={{ width: `${Math.round(value * 100)}%` }} />
    </span>
  );
}
