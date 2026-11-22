using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class WinvmDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields;
    public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string dev, int i, ref DISPLAY_DEVICE dd, int flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettingsEx(string dev, int mode, ref DEVMODE dm, int flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr hwnd, int flags, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(long pt, int flags);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr mon, int type, out uint x, out uint y);
  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint np, out uint nm);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint np, byte[] paths, ref uint nm, byte[] modes, IntPtr topo);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(byte[] packet);
  [DllImport("user32.dll")] static extern int DisplayConfigSetDeviceInfo(byte[] packet);

  const int ENUM_CURRENT_SETTINGS = -1;
  const int DM_PELSWIDTH = 0x80000, DM_PELSHEIGHT = 0x100000;
  const int CDS_UPDATEREGISTRY = 1;
  const uint QDC_ONLY_ACTIVE_PATHS = 2;
  const long MAX_FRAMEBUFFER_BYTES = 30L * 1024 * 1024;
  static readonly int[] Scales = { 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500 };

  class Fail : Exception {
    public readonly string Code;
    public Fail(string code, string msg) : base(msg) { Code = code; }
  }

  static string Primary() {
    var dd = new DISPLAY_DEVICE(); dd.cb = Marshal.SizeOf(dd);
    for (int i = 0; EnumDisplayDevices(null, i, ref dd, 0); i++) {
      if ((dd.StateFlags & 4) != 0) return dd.DeviceName;
      dd.cb = Marshal.SizeOf(dd);
    }
    throw new Fail("fail", "no primary display");
  }

  static DEVMODE Current(string dev) {
    var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(dm);
    if (!EnumDisplaySettingsEx(dev, ENUM_CURRENT_SETTINGS, ref dm, 0)) throw new Fail("fail", "cannot read the current mode");
    return dm;
  }

  static List<int[]> Modes(string dev) {
    var seen = new HashSet<long>(); var list = new List<int[]>();
    var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(dm);
    for (int i = 0; EnumDisplaySettingsEx(dev, i, ref dm, 0); i++) {
      long k = (long)dm.dmPelsWidth * 100000 + dm.dmPelsHeight;
      if (seen.Add(k)) list.Add(new[] { dm.dmPelsWidth, dm.dmPelsHeight });
    }
    list.Sort((a, b) => a[0] != b[0] ? a[0].CompareTo(b[0]) : a[1].CompareTo(b[1]));
    return list;
  }

  static bool Offered(string dev, int w, int h) {
    var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(dm);
    for (int i = 0; EnumDisplaySettingsEx(dev, i, ref dm, 0); i++) if (dm.dmPelsWidth == w && dm.dmPelsHeight == h) return true;
    return false;
  }

  static uint EffectiveDpi() {
    uint x, y;
    return GetDpiForMonitor(MonitorFromPoint(0, 1), 0, out x, out y) == 0 ? x : 0;
  }

  static byte[] Header(int type, int size) {
    uint np, nm;
    if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out np, out nm) != 0) throw new Fail("fail", "GetDisplayConfigBufferSizes failed");
    var paths = new byte[np * 72]; var modes = new byte[nm * 64];
    int r = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref np, paths, ref nm, modes, IntPtr.Zero);
    if (r != 0 || np == 0) throw new Fail("fail", "QueryDisplayConfig failed: " + r);
    var b = new byte[size];
    BitConverter.GetBytes(type).CopyTo(b, 0);
    BitConverter.GetBytes(size).CopyTo(b, 4);
    Array.Copy(paths, 0, b, 8, 12);
    return b;
  }

  static int[] ScaleSteps() {
    var b = Header(-3, 32);
    int r = DisplayConfigGetDeviceInfo(b);
    if (r != 0) throw new Fail("fail", "cannot read the display scale: " + r);
    return new[] { BitConverter.ToInt32(b, 20), BitConverter.ToInt32(b, 24), BitConverter.ToInt32(b, 28) };
  }

  static int StepPercent(int recommendedIndex, int rel) {
    int i = Math.Max(0, Math.Min(Scales.Length - 1, recommendedIndex + rel));
    return Scales[i];
  }

  static bool SetScale(int pct) {
    int idx = Array.IndexOf(Scales, pct);
    if (idx < 0) throw new Fail("bad", "not a scale Windows offers: " + pct);
    var s = ScaleSteps();
    int rec = -s[0];
    int rel = idx - rec;
    if (rel == s[1]) return false;
    var b = Header(-4, 24);
    BitConverter.GetBytes(rel).CopyTo(b, 20);
    int r = DisplayConfigSetDeviceInfo(b);
    if (r != 0) throw new Fail("fail", "cannot set the display scale: " + r);
    return true;
  }

  static void State(StringBuilder j, string dev) {
    var c = Current(dev);
    var s = ScaleSteps();
    int rec = -s[0];
    j.Append("\"width\":").Append(c.dmPelsWidth).Append(",\"height\":").Append(c.dmPelsHeight);
    j.Append(",\"scale\":").Append(StepPercent(rec, s[1]));
    j.Append(",\"maxScale\":").Append(StepPercent(rec, s[2]));
    j.Append(",\"dpi\":").Append(EffectiveDpi());
  }

  static int Int(string[] a, int i, int dflt) { return a.Length > i ? int.Parse(a[i]) : dflt; }

  static int Run(string[] a, out string json) {
    var j = new StringBuilder("{");
    try {
      string dev = Primary();
      string cmd = a.Length > 0 ? a[0] : "get";
      if (cmd == "get") {
        State(j, dev);
      } else if (cmd == "modes") {
        State(j, dev);
        j.Append(",\"modes\":[");
        bool first = true;
        foreach (var m in Modes(dev)) { if (!first) j.Append(','); first = false; j.Append("\"").Append(m[0]).Append('x').Append(m[1]).Append("\""); }
        j.Append(']');
      } else if (cmd == "set") {
        int w = Int(a, 1, 0), h = Int(a, 2, 0), waitMs = Int(a, 3, 2000), pct = Int(a, 4, 0);
        if (w < 640 || h < 480) throw new Fail("bad", "size too small: " + w + "x" + h);
        if ((long)w * h * 4 > MAX_FRAMEBUFFER_BYTES) throw new Fail("toobig", w + "x" + h + " needs more than the driver's 30 MiB framebuffer");
        var sw = Stopwatch.StartNew();
        var cur = Current(dev);
        bool changed = false;
        if (cur.dmPelsWidth != w || cur.dmPelsHeight != h) {
          while (!Offered(dev, w, h)) {
            if (sw.ElapsedMilliseconds >= waitMs) throw new Fail("timeout", "the driver did not offer " + w + "x" + h + " within " + waitMs + " ms (was it requested over VNC first?)");
            System.Threading.Thread.Sleep(10);
          }
          cur.dmPelsWidth = w; cur.dmPelsHeight = h; cur.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
          int r = ChangeDisplaySettingsEx(dev, ref cur, IntPtr.Zero, CDS_UPDATEREGISTRY, IntPtr.Zero);
          if (r == -2) throw new Fail("badmode", "the driver refused " + w + "x" + h);
          if (r != 0) throw new Fail("fail", "ChangeDisplaySettingsEx returned " + r);
          changed = true;
        }
        bool scaled = pct > 0 && SetScale(pct);
        j.Append("\"changed\":").Append(changed ? "true" : "false").Append(",\"scaled\":").Append(scaled ? "true" : "false");
        j.Append(",\"ms\":").Append(sw.ElapsedMilliseconds).Append(',');
        State(j, dev);
      } else if (cmd == "scale") {
        bool scaled = SetScale(Int(a, 1, 100));
        j.Append("\"scaled\":").Append(scaled ? "true" : "false").Append(',');
        State(j, dev);
      } else {
        throw new Fail("bad", "usage: get | modes | set W H [waitMs] [scale] | scale PCT");
      }
      j.Append('}');
      json = j.ToString();
      return 0;
    } catch (Fail f) {
      json = Error(f.Message, f.Code);
      return 1;
    } catch (Exception e) {
      json = Error(e.Message, "fail");
      return 1;
    }
  }

  static string Error(string msg, string code) {
    return "{\"error\":\"" + msg.Replace("\\", "\\\\").Replace("\"", "'") + "\",\"code\":\"" + code + "\"}";
  }

  public static int Main(string[] a) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    string json;
    if (a.Length > 0 && a[0] == "serve") {
      for (string line = Console.In.ReadLine(); line != null; line = Console.In.ReadLine()) {
        var words = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
        if (words.Length == 0) continue;
        if (words[0] == "serve") json = Error("already serving", "bad");
        else Run(words, out json);
        Console.Out.WriteLine(json);
        Console.Out.Flush();
      }
      return 0;
    }
    int code = Run(a, out json);
    Console.WriteLine(json);
    return code;
  }
}
