"use client";

/**
 * The service's access key, entered once per browser. Shown only when GET /health says
 * the service asks for one, so local development has nothing to fill in.
 */
import { useEffect, useState } from "react";
import { getAccessKey, setAccessKey } from "@/lib/access";
import { getHealth } from "@/lib/service";

export default function AccessKeyField() {
  const [required, setRequired] = useState(false);
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);

  // Subscribing to an external system: state lands in the promise callback.
  useEffect(() => {
    let live = true;
    getHealth()
      .then((h) => {
        if (!live) return;
        const stored = getAccessKey();
        setRequired(Boolean(h.accessKeyRequired));
        setValue(stored);
        setSaved(Boolean(stored));
      })
      .catch(() => {
        /* the job views surface a service that is down */
      });
    return () => {
      live = false;
    };
  }, []);

  if (!required) return null;

  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        setAccessKey(value.trim());
        setSaved(Boolean(value.trim()));
      }}
    >
      <input
        type="password"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
        }}
        placeholder="access key"
        aria-label="Access key"
        autoComplete="off"
        className="w-28 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs"
      />
      <button className={`rounded-md border px-2 py-1 text-[11px] ${saved ? "border-emerald-800 text-emerald-300" : "border-amber-500 text-amber-300"}`}>
        {saved ? "key saved" : "save key"}
      </button>
    </form>
  );
}
