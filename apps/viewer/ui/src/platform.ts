export type OsKind = "macos" | "windows" | "linux";

export function osKind(): OsKind {
  if (typeof navigator === "undefined") return "macos";
  const uaData = (navigator as { userAgentData?: { platform?: string } })
    .userAgentData;
  const signal = uaData?.platform ?? navigator.userAgent;
  if (/win/i.test(signal)) return "windows";
  if (/linux|x11/i.test(signal) && !/android/i.test(signal)) return "linux";
  return "macos";
}
