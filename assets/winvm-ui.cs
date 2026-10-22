// winvm-ui: UI Automation for the in-guest agent. A long-lived process the
// agent's spawner starts in the logged-on session and talks to over stdio,
// one JSON object per line each way:
//
//   in   {"id": 7, "op": "click", "window": "Maximal", "name": "Settings", "timeoutMs": 5000}
//   out  {"id": 7, "result": {...}}   or   {"id": 7, "error": "...", "code": "notfound"}
//
// Requests run concurrently (a `wait` does not hold up a `find`). It exits
// when stdin closes, so it never outlives the agent. Compiled in the guest by
// agent-install.ps1 with Add-Type (C# 5, the in-box .NET Framework compiler):
// AnyCPU, so it runs as native ARM64 under .NET Framework 4.8.1.
//
// A selector picks the scope, then the element:
//   window   top-level window: Name contains this (case-insensitive), or ClassName equals it
//   process  top-level windows of processes with this name ("maximal-shell", ".exe" optional)
//   hwnd     a window handle
//   name | nameContains | automationId | controlType | className | index
// No window/process/hwnd: the whole desktop (slower: every window is searched).
//
// Ops: ping, windows, tree, find, wait, act (click | rightclick | doubleclick |
// invoke | toggle | expand | collapse | select | setvalue | focus | type),
// focus, settle, tray, menu. See docs/gui.md.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

class UiError : Exception {
  public readonly string Code;
  public UiError(string code, string message) : base(message) { Code = code; }
}

static class WinvmUi {
  // ui.ts UI_HELPER_VERSION must match: the host reinstalls the agent when it does not.
  const int VERSION = 3;

  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern uint GetDpiForSystem();
  [DllImport("kernel32.dll")] static extern bool IsWow64Process2(IntPtr p, out ushort pm, out ushort nm);
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  // INPUT is a union; MOUSEINPUT is its largest member (32 bytes on 64-bit, after an 8-byte-aligned type).
  [StructLayout(LayoutKind.Explicit)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);

  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 1000 };
  static readonly object OutLock = new object();
  static readonly object InputLock = new object();
  static TextWriter Out;
  static string LogFile;
  static readonly object LogLock = new object();

  /** One line per request, start and end, beside the exe: what hung, and for how long. */
  static void Log(string s) {
    if (LogFile == null) return;
    try {
      lock (LogLock) {
        var f = new FileInfo(LogFile);
        if (f.Exists && f.Length > 4 * 1024 * 1024) File.Delete(LogFile);
        File.AppendAllText(LogFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + s + "\r\n");
      }
    } catch { }
  }
  static bool DpiAware;
  static int pending;

  static int Main(string[] args) {
    // Physical pixels everywhere: UIA bounds == SendInput coordinates == the framebuffer.
    DpiAware = SetProcessDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
    Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
    var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    try { LogFile = Path.Combine(Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName), "winvm-ui.log"); } catch { }
    Log("start pid " + Process.GetCurrentProcess().Id);
    // Warm UIA up front: the first cross-process call costs ~100 ms or more.
    ThreadPool.QueueUserWorkItem(delegate { try { AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition); } catch { } });
    string line;
    while ((line = input.ReadLine()) != null) {
      if (line.Trim() == "") continue;
      string l = line;
      Interlocked.Increment(ref pending);
      ThreadPool.QueueUserWorkItem(delegate { try { Handle(l); } finally { Interlocked.Decrement(ref pending); } });
    }
    // stdin closed: finish what was asked (briefly), then go.
    for (int i = 0; i < 100 && Thread.VolatileRead(ref pending) > 0; i++) Thread.Sleep(50);
    return 0;
  }

  static void Handle(string line) {
    object id = null;
    var sw = Stopwatch.StartNew();
    Dictionary<string, object> reply;
    int answered = 0;
    Timer watchdog = null;
    try {
      var req = Json.Deserialize<Dictionary<string, object>>(line);
      req.TryGetValue("id", out id);
      Log("> " + line);
      // A UIA call into a hung provider can block for minutes: answer anyway
      // once the request is well past its own deadline, and leave the thread.
      // (act with settleMs looks for its element twice, and settles in between.)
      int limit = 2 * Int(req, "timeoutMs", 0) + Int(req, "settleTimeoutMs", 5000) + 20000;
      object wid = id;
      watchdog = new Timer(delegate {
        if (Interlocked.CompareExchange(ref answered, 1, 0) != 0) return;
        Reply(new Dictionary<string, object> { { "id", wid }, { "error", "no answer from UI Automation after " + limit + " ms (a hung window?)" }, { "code", "timeout" } }, sw);
      }, null, limit, Timeout.Infinite);
      var result = Dispatch(Str(req, "op") ?? "", req);
      result["ms"] = sw.ElapsedMilliseconds;
      reply = new Dictionary<string, object> { { "id", id }, { "result", result } };
    } catch (UiError e) {
      reply = new Dictionary<string, object> { { "id", id }, { "error", e.Message }, { "code", e.Code } };
    } catch (Exception e) {
      reply = new Dictionary<string, object> { { "id", id }, { "error", e.GetType().Name + ": " + e.Message }, { "code", "fail" } };
    }
    if (watchdog != null) watchdog.Dispose();
    if (Interlocked.CompareExchange(ref answered, 1, 0) == 0) Reply(reply, sw);
    else Log("< " + Convert.ToString(id) + " finished after the watchdog, " + sw.ElapsedMilliseconds + " ms");
  }

  static void Reply(Dictionary<string, object> reply, Stopwatch sw) {
    string text = Json.Serialize(reply);
    Log("< " + Convert.ToString(reply["id"]) + " " + sw.ElapsedMilliseconds + " ms" + (reply.ContainsKey("error") ? " " + reply["code"] + ": " + reply["error"] : ""));
    lock (OutLock) Out.WriteLine(text);
  }


  // --- request fields --------------------------------------------------------

  static string Str(Dictionary<string, object> b, string k) {
    object v;
    return b.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null;
  }
  static int Int(Dictionary<string, object> b, string k, int dflt) {
    object v;
    return b.TryGetValue(k, out v) && v != null ? Convert.ToInt32(v) : dflt;
  }
  static bool Bool(Dictionary<string, object> b, string k) {
    object v;
    return b.TryGetValue(k, out v) && v is bool && (bool)v;
  }
  static Dictionary<string, object> Obj(params object[] kv) {
    var d = new Dictionary<string, object>();
    for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
    return d;
  }

  static Dictionary<string, object> Dispatch(string op, Dictionary<string, object> b) {
    switch (op) {
      case "ping": {
        ushort pm, nm;
        IsWow64Process2(Process.GetCurrentProcess().Handle, out pm, out nm);
        return Obj("version", VERSION, "pid", Process.GetCurrentProcess().Id, "session", Process.GetCurrentProcess().SessionId,
          "arch", nm == 0xAA64 && pm == 0 ? "arm64" : pm == 0 ? "native" : "emulated", "dpiAware", DpiAware,
          "dpi", GetDpiForSystem(), "screen", new[] { GetSystemMetrics(0), GetSystemMetrics(1) });
      }
      case "windows": {
        var list = new List<object>();
        foreach (AutomationElement w in TopLevel()) {
          var d = Describe(w, true);
          d["process"] = ProcessName(w.Cached.ProcessId);
          list.Add(d);
        }
        return Obj("windows", list);
      }
      case "tree": return Tree(b);
      case "find": {
        int timeout = Int(b, "timeoutMs", 0);
        if (Bool(b, "all")) {
          var all = FindAll(b, timeout);
          return Obj("elements", all.Select(e => (object)Describe(e, true)).ToList());
        }
        return Obj("element", Describe(Find(b, timeout), true));
      }
      case "wait": return Wait(b);
      case "act": return Act(b);
      case "focus": {
        var roots = Roots(b, Int(b, "timeoutMs", 0));
        if (roots.Count == 0) throw new UiError("bad", "focus needs window, process or hwnd");
        return Obj("foreground", Focus(roots[0]), "window", Describe(roots[0], true));
      }
      case "settle": return Settle(b);
      case "tray": return Tray(b);
      case "menu": return Menu(b, Str(b, "name"), Int(b, "timeoutMs", 5000), Str(b, "action") ?? "click");
    }
    throw new UiError("bad", "unknown op \"" + op + "\"");
  }

  // --- elements --------------------------------------------------------------

  static readonly AutomationProperty[] Props = {
    AutomationElement.NameProperty, AutomationElement.ControlTypeProperty, AutomationElement.AutomationIdProperty,
    AutomationElement.ClassNameProperty, AutomationElement.BoundingRectangleProperty, AutomationElement.IsEnabledProperty,
    AutomationElement.IsOffscreenProperty, AutomationElement.HasKeyboardFocusProperty, AutomationElement.ProcessIdProperty,
    AutomationElement.NativeWindowHandleProperty, AutomationElement.FrameworkIdProperty,
    AutomationElement.IsValuePatternAvailableProperty, AutomationElement.IsTogglePatternAvailableProperty,
    AutomationElement.IsExpandCollapsePatternAvailableProperty, AutomationElement.IsSelectionItemPatternAvailableProperty,
    ValuePattern.ValueProperty, TogglePattern.ToggleStateProperty, ExpandCollapsePattern.ExpandCollapseStateProperty,
    SelectionItemPattern.IsSelectedProperty,
  };

  static CacheRequest Cache(TreeScope scope) {
    var cr = new CacheRequest();
    foreach (var p in Props) cr.Add(p);
    cr.TreeScope = scope;
    cr.TreeFilter = Automation.ControlViewCondition;
    cr.AutomationElementMode = AutomationElementMode.Full;
    return cr;
  }

  static object Prop(AutomationElement e, AutomationProperty p) {
    try { return e.GetCachedPropertyValue(p, true); } catch { }
    try { return e.GetCurrentPropertyValue(p, true); } catch { return null; }
  }

  static AutomationElement.AutomationElementInformation Info(AutomationElement e, bool cached) {
    if (cached) { try { return e.Cached; } catch (InvalidOperationException) { } }
    return e.Current;
  }

  static Dictionary<string, object> Describe(AutomationElement e, bool cached) {
    var i = Info(e, cached);
    var r = i.BoundingRectangle;
    var d = new Dictionary<string, object>();
    d["name"] = i.Name;
    d["controlType"] = i.ControlType.ProgrammaticName.Replace("ControlType.", "");
    if (!string.IsNullOrEmpty(i.AutomationId)) d["automationId"] = i.AutomationId;
    if (!string.IsNullOrEmpty(i.ClassName)) d["className"] = i.ClassName;
    if (!string.IsNullOrEmpty(i.FrameworkId)) d["framework"] = i.FrameworkId;
    d["bounds"] = r.IsEmpty || double.IsInfinity(r.X) ? null : new[] { (int)r.X, (int)r.Y, (int)r.Width, (int)r.Height };
    if (!i.IsEnabled) d["enabled"] = false;
    if (i.IsOffscreen) d["offscreen"] = true;
    if (i.HasKeyboardFocus) d["focused"] = true;
    if (i.NativeWindowHandle != 0) d["hwnd"] = i.NativeWindowHandle;
    d["pid"] = i.ProcessId;
    if (true.Equals(Prop(e, AutomationElement.IsValuePatternAvailableProperty))) d["value"] = Convert.ToString(Prop(e, ValuePattern.ValueProperty));
    if (true.Equals(Prop(e, AutomationElement.IsTogglePatternAvailableProperty))) d["toggle"] = Convert.ToString(Prop(e, TogglePattern.ToggleStateProperty));
    if (true.Equals(Prop(e, AutomationElement.IsExpandCollapsePatternAvailableProperty))) d["expanded"] = Convert.ToString(Prop(e, ExpandCollapsePattern.ExpandCollapseStateProperty));
    if (true.Equals(Prop(e, AutomationElement.IsSelectionItemPatternAvailableProperty))) d["selected"] = Prop(e, SelectionItemPattern.IsSelectedProperty);
    return d;
  }

  static string ProcessName(int pid) {
    try { return Process.GetProcessById(pid).ProcessName; } catch { return null; }
  }

  static List<AutomationElement> TopLevel() {
    using (Cache(TreeScope.Element).Activate())
      return AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition).Cast<AutomationElement>().ToList();
  }

  static bool HasScope(Dictionary<string, object> b) {
    return b.ContainsKey("window") || b.ContainsKey("process") || b.ContainsKey("hwnd");
  }

  /** The top-level windows a selector scopes to; empty when it names none (the desktop). Waits up to timeoutMs for one. */
  static List<AutomationElement> Roots(Dictionary<string, object> b, int timeoutMs) {
    if (!HasScope(b)) return new List<AutomationElement>();
    string window = Str(b, "window"), proc = Str(b, "process"), hwnd = Str(b, "hwnd");
    int deadline = Environment.TickCount + timeoutMs;
    while (true) {
      var found = new List<AutomationElement>();
      if (hwnd != null) {
        try { found.Add(AutomationElement.FromHandle(new IntPtr(Convert.ToInt64(hwnd)))); } catch { }
      } else {
        HashSet<int> pids = null;
        if (proc != null) {
          string p = proc.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? proc.Substring(0, proc.Length - 4) : proc;
          pids = new HashSet<int>(Process.GetProcessesByName(p).Select(x => x.Id));
        }
        foreach (var w in TopLevel()) {
          var i = w.Cached;
          if (pids != null && !pids.Contains(i.ProcessId)) continue;
          if (window != null && i.Name.IndexOf(window, StringComparison.OrdinalIgnoreCase) < 0 && i.ClassName != window) continue;
          found.Add(w);
        }
      }
      if (found.Count > 0) return found;
      if (Environment.TickCount - deadline >= 0)
        throw new UiError("notfound", "no window matching " + Json.Serialize(Scope(b)));
      Thread.Sleep(50);
    }
  }

  static Dictionary<string, object> Scope(Dictionary<string, object> b) {
    var d = new Dictionary<string, object>();
    foreach (var k in new[] { "window", "process", "hwnd" }) if (b.ContainsKey(k)) d[k] = b[k];
    return d;
  }

  static Dictionary<string, object> Sel(Dictionary<string, object> b) {
    var d = Scope(b);
    foreach (var k in new[] { "name", "nameContains", "automationId", "controlType", "className", "index" }) if (b.ContainsKey(k)) d[k] = b[k];
    return d;
  }

  static ControlType ParseControlType(string ct) {
    var f = typeof(ControlType).GetField(ct, System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.IgnoreCase);
    if (f == null) throw new UiError("bad", "unknown controlType \"" + ct + "\" (Button, MenuItem, Window, Edit, CheckBox, ...)");
    return (ControlType)f.GetValue(null);
  }

  static Condition Cond(Dictionary<string, object> b) {
    var conds = new List<Condition>();
    if (b.ContainsKey("name")) conds.Add(new PropertyCondition(AutomationElement.NameProperty, Str(b, "name"), PropertyConditionFlags.IgnoreCase));
    if (b.ContainsKey("automationId")) conds.Add(new PropertyCondition(AutomationElement.AutomationIdProperty, Str(b, "automationId")));
    if (b.ContainsKey("className")) conds.Add(new PropertyCondition(AutomationElement.ClassNameProperty, Str(b, "className")));
    if (b.ContainsKey("controlType")) conds.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, ParseControlType(Str(b, "controlType"))));
    return conds.Count == 0 ? Condition.TrueCondition : conds.Count == 1 ? conds[0] : new AndCondition(conds.ToArray());
  }

  /** One pass: every match, in document order, the scope windows themselves included. */
  static List<AutomationElement> Matches(Dictionary<string, object> b, List<AutomationElement> roots) {
    var c = Cond(b);
    string contains = Str(b, "nameContains");
    var hits = new List<AutomationElement>();
    using (Cache(TreeScope.Element).Activate()) {
      if (roots.Count == 0) {
        hits.AddRange(AutomationElement.RootElement.FindAll(TreeScope.Descendants, c).Cast<AutomationElement>());
      } else {
        foreach (var r in roots) {
          try { hits.AddRange(r.FindAll(TreeScope.Subtree, c).Cast<AutomationElement>()); } catch (ElementNotAvailableException) { }
        }
      }
    }
    if (contains != null) hits = hits.Where(e => Info(e, true).Name.IndexOf(contains, StringComparison.OrdinalIgnoreCase) >= 0).ToList();
    return hits;
  }

  static AutomationElement Find(Dictionary<string, object> b, int timeoutMs) {
    int index = Int(b, "index", 0);
    int deadline = Environment.TickCount + timeoutMs;
    while (true) {
      try {
        var hits = Matches(b, Roots(b, Math.Max(0, deadline - Environment.TickCount)));
        if (hits.Count > index) return hits[index];
      } catch (ElementNotAvailableException) {
        // the tree changed under us; look again
      }
      if (Environment.TickCount - deadline >= 0) throw new UiError("notfound", "no element matching " + Json.Serialize(Sel(b)));
      Thread.Sleep(50);
    }
  }

  static List<AutomationElement> FindAll(Dictionary<string, object> b, int timeoutMs) {
    int deadline = Environment.TickCount + timeoutMs;
    while (true) {
      var hits = Matches(b, Roots(b, Math.Max(0, deadline - Environment.TickCount)));
      if (hits.Count > 0 || Environment.TickCount - deadline >= 0) return hits;
      Thread.Sleep(50);
    }
  }

  static bool HasElementSel(Dictionary<string, object> b) {
    return b.ContainsKey("name") || b.ContainsKey("nameContains") || b.ContainsKey("automationId") || b.ContainsKey("controlType") || b.ContainsKey("className");
  }

  // --- tree ------------------------------------------------------------------

  static Dictionary<string, object> Tree(Dictionary<string, object> b) {
    int depth = Int(b, "depth", HasScope(b) || HasElementSel(b) ? 64 : 1);
    int max = Int(b, "max", 5000);
    int count = 0;
    bool truncated = false;
    var trees = new List<object>();
    List<AutomationElement> roots;
    if (HasElementSel(b)) roots = new List<AutomationElement> { Find(b, Int(b, "timeoutMs", 0)) };
    else if (HasScope(b)) roots = Roots(b, Int(b, "timeoutMs", 0));
    else {
      // The desktop: its windows, each walked to depth - 1.
      var desk = Obj("name", "Desktop", "controlType", "Pane");
      var kids = new List<object>();
      count = 1;
      foreach (var w in TopLevel()) {
        if (count >= max) { truncated = true; break; }
        kids.Add(depth <= 1 ? Describe(w, true) : WalkFrom(w, depth - 1, max, ref count, ref truncated));
        if (depth <= 1) count++;
      }
      desk["children"] = kids;
      return Obj("count", count, "truncated", truncated, "tree", desk);
    }
    foreach (var r in roots) trees.Add(WalkFrom(r, depth, max, ref count, ref truncated));
    return Obj("count", count, "truncated", truncated, "tree", trees.Count == 1 ? trees[0] : Obj("name", "", "controlType", "List", "children", trees));
  }

  /** One cross-process call caches the whole subtree; then walk it locally. */
  static Dictionary<string, object> WalkFrom(AutomationElement root, int depth, int max, ref int count, ref bool truncated) {
    AutomationElement cached;
    using (Cache(TreeScope.Subtree).Activate()) cached = root.GetUpdatedCache(Cache(TreeScope.Subtree));
    return Walk(cached, depth, max, ref count, ref truncated);
  }

  static Dictionary<string, object> Walk(AutomationElement e, int depth, int max, ref int count, ref bool truncated) {
    count++;
    var d = Describe(e, true);
    if (depth > 0) {
      var kids = new List<object>();
      foreach (AutomationElement k in e.CachedChildren) {
        if (count >= max) { truncated = true; break; }
        kids.Add(Walk(k, depth - 1, max, ref count, ref truncated));
      }
      if (kids.Count > 0) d["children"] = kids;
    }
    return d;
  }

  // --- wait and settle -------------------------------------------------------

  static Dictionary<string, object> Wait(Dictionary<string, object> b) {
    int timeout = Int(b, "timeoutMs", 10000);
    var sw = Stopwatch.StartNew();
    if (!Bool(b, "gone")) {
      var e = Find(b, timeout);
      return Obj("element", Describe(e, true), "waitedMs", sw.ElapsedMilliseconds);
    }
    while (true) {
      bool present;
      try {
        present = HasElementSel(b) ? Matches(b, Roots(b, 0)).Count > Int(b, "index", 0) : Roots(b, 0).Count > 0;
      } catch (UiError) { present = false; }
      if (!present) return Obj("gone", true, "waitedMs", sw.ElapsedMilliseconds);
      if (sw.ElapsedMilliseconds >= timeout) throw new UiError("timeout", "still there after " + timeout + " ms: " + Json.Serialize(Sel(b)));
      Thread.Sleep(50);
    }
  }

  /**
   * Wait until the UI stops changing: the scope's element tree (names, types,
   * bounds, states) is identical for quietMs. Scope: the selector's windows,
   * else every top-level window plus the foreground window's whole subtree.
   */
  static Dictionary<string, object> Settle(Dictionary<string, object> b) {
    int quiet = Int(b, "quietMs", 300), timeout = Int(b, "timeoutMs", 10000), interval = Int(b, "intervalMs", 50);
    var sw = Stopwatch.StartNew();
    long last = 0, changedAt = 0;
    int polls = 0, changes = 0;
    while (true) {
      long sig;
      int n;
      try { sig = Signature(b, out n); } catch (ElementNotAvailableException) { sig = -1; n = 0; } catch (UiError) { sig = -2; n = 0; }
      polls++;
      long now = sw.ElapsedMilliseconds;
      if (polls == 1 || sig != last) { if (polls > 1) changes++; last = sig; changedAt = now; }
      else if (now - changedAt >= quiet) return Obj("settled", true, "settledMs", now, "polls", polls, "changes", changes, "elements", n);
      if (now >= timeout) return Obj("settled", false, "settledMs", now, "polls", polls, "changes", changes, "elements", n);
      Thread.Sleep(interval);
    }
  }

  static long Signature(Dictionary<string, object> b, out int n) {
    var sb = new StringBuilder();
    n = 0;
    List<AutomationElement> roots;
    if (HasScope(b)) roots = Roots(b, 0);
    else {
      var top = TopLevel();
      foreach (var w in top) { Sign(sb, w); n++; }
      roots = new List<AutomationElement>();
      var fg = GetForegroundWindow();
      if (fg != IntPtr.Zero) { try { roots.Add(AutomationElement.FromHandle(fg)); } catch { } }
    }
    foreach (var r in roots) {
      AutomationElement c;
      using (Cache(TreeScope.Subtree).Activate()) c = r.GetUpdatedCache(Cache(TreeScope.Subtree));
      n += SignTree(sb, c, 0);
    }
    // FNV-1a, 64-bit
    ulong h = 14695981039346656037UL;
    foreach (char ch in sb.ToString()) { h ^= ch; h *= 1099511628211UL; }
    return (long)h;
  }

  static int SignTree(StringBuilder sb, AutomationElement e, int level) {
    if (level > 40) return 0;
    Sign(sb, e);
    int n = 1;
    sb.Append('(');
    foreach (AutomationElement k in e.CachedChildren) n += SignTree(sb, k, level + 1);
    sb.Append(')');
    return n;
  }

  static void Sign(StringBuilder sb, AutomationElement e) {
    var i = Info(e, true);
    var r = i.BoundingRectangle;
    sb.Append(i.ControlType.Id).Append('|').Append(i.Name).Append('|').Append(i.AutomationId).Append('|')
      .Append(r.IsEmpty ? "-" : ((int)r.X + "," + (int)r.Y + "," + (int)r.Width + "," + (int)r.Height)).Append('|')
      .Append(i.IsEnabled ? 'e' : 'd').Append(i.IsOffscreen ? 'o' : 'v')
      .Append(Prop(e, ValuePattern.ValueProperty)).Append(Prop(e, TogglePattern.ToggleStateProperty)).Append(';');
  }

  // --- acting ----------------------------------------------------------------

  static Dictionary<string, object> Act(Dictionary<string, object> b) {
    string action = Str(b, "action") ?? "click";
    var e = Find(b, Int(b, "timeoutMs", 0));
    int settleMs = Int(b, "settleMs", 0);
    if (settleMs > 0) {
      // Settle the window the element lives in, then find it again (it may have moved).
      var top = TopWindowOf(e);
      if (top != null) {
        var sb = Obj("hwnd", top.Current.NativeWindowHandle, "quietMs", settleMs, "timeoutMs", Int(b, "settleTimeoutMs", 5000));
        Settle(sb);
        e = Find(b, Int(b, "timeoutMs", 0));
      }
    }
    var before = Describe(e, false);
    object pat;
    string did = action;
    switch (action) {
      case "click": case "rightclick": case "doubleclick": case "middleclick": {
        int[] at = ClickPoint(e);
        Click(at[0], at[1], action == "rightclick" ? "right" : action == "middleclick" ? "middle" : "left", action == "doubleclick" ? 2 : 1);
        return Obj("did", action, "at", at, "element", before);
      }
      case "invoke":
        if (e.TryGetCurrentPattern(InvokePattern.Pattern, out pat)) { ((InvokePattern)pat).Invoke(); did = "Invoke"; }
        else if (e.TryGetCurrentPattern(TogglePattern.Pattern, out pat)) { ((TogglePattern)pat).Toggle(); did = "Toggle"; }
        else if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) { ((SelectionItemPattern)pat).Select(); did = "Select"; }
        else if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pat)) { ((ExpandCollapsePattern)pat).Expand(); did = "Expand"; }
        else throw new UiError("bad", "the element has no Invoke, Toggle, SelectionItem or ExpandCollapse pattern; use click");
        break;
      case "toggle": Pattern<TogglePattern>(e, TogglePattern.Pattern, "Toggle").Toggle(); break;
      case "expand": Pattern<ExpandCollapsePattern>(e, ExpandCollapsePattern.Pattern, "ExpandCollapse").Expand(); break;
      case "collapse": Pattern<ExpandCollapsePattern>(e, ExpandCollapsePattern.Pattern, "ExpandCollapse").Collapse(); break;
      case "select": Pattern<SelectionItemPattern>(e, SelectionItemPattern.Pattern, "SelectionItem").Select(); break;
      case "setvalue": {
        string value = Str(b, "value");
        if (value == null) throw new UiError("bad", "setvalue needs value");
        Pattern<ValuePattern>(e, ValuePattern.Pattern, "Value").SetValue(value);
        break;
      }
      case "focus": e.SetFocus(); break;
      case "type": {
        string text = Str(b, "value");
        if (text == null) throw new UiError("bad", "type needs value");
        try { e.SetFocus(); } catch { }
        Type(text);
        break;
      }
      default: throw new UiError("bad", "unknown action \"" + action + "\"");
    }
    return Obj("did", did, "element", before);
  }

  static T Pattern<T>(AutomationElement e, AutomationPattern p, string what) where T : BasePattern {
    object pat;
    if (!e.TryGetCurrentPattern(p, out pat)) throw new UiError("bad", "the element has no " + what + " pattern");
    return (T)pat;
  }

  static AutomationElement TopWindowOf(AutomationElement e) {
    var walker = TreeWalker.ControlViewWalker;
    var root = AutomationElement.RootElement;
    AutomationElement cur = e, parent;
    try {
      while ((parent = walker.GetParent(cur)) != null && !Automation.Compare(parent, root)) cur = parent;
    } catch (ElementNotAvailableException) { return null; }
    return cur;
  }

  static int[] ClickPoint(AutomationElement e) {
    object pat;
    if (e.Current.IsOffscreen && e.TryGetCurrentPattern(ScrollItemPattern.Pattern, out pat)) {
      try { ((ScrollItemPattern)pat).ScrollIntoView(); Thread.Sleep(50); } catch { }
    }
    var r = e.Current.BoundingRectangle;
    if (r.IsEmpty || double.IsInfinity(r.X) || r.Width <= 0 || r.Height <= 0)
      throw new UiError("bad", "the element has no on-screen bounds to click (offscreen or hidden); try invoke");
    return new[] { (int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2) };
  }

  /** Real input: move there, press, release. Absolute coordinates over the virtual desktop. */
  static void Click(int x, int y, string button, int times) {
    uint down = button == "right" ? 0x0008u : button == "middle" ? 0x0020u : 0x0002u;
    uint up = button == "right" ? 0x0010u : button == "middle" ? 0x0040u : 0x0004u;
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    int nx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1)), ny = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
    lock (InputLock) {
      Send(Mouse(nx, ny, 0x0001 | 0x8000 | 0x4000)); // MOVE | ABSOLUTE | VIRTUALDESK
      Thread.Sleep(40); // a hover first: XAML buttons (the tray) want to see the pointer arrive
      for (int i = 0; i < times; i++) {
        Send(Mouse(nx, ny, down | 0x8000 | 0x4000));
        Thread.Sleep(30);
        Send(Mouse(nx, ny, up | 0x8000 | 0x4000));
        if (i + 1 < times) Thread.Sleep(60);
      }
    }
  }

  static INPUT Mouse(int nx, int ny, uint flags) {
    var i = new INPUT();
    i.type = 0;
    i.mi.dx = nx; i.mi.dy = ny; i.mi.dwFlags = flags;
    return i;
  }

  static void Send(params INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
      throw new UiError("fail", "SendInput was blocked (error " + Marshal.GetLastWin32Error() + "): is the desktop locked, or a UAC prompt up?");
  }

  /** KEYEVENTF_UNICODE: any character, whatever the keyboard layout. */
  static void Type(string text) {
    lock (InputLock) {
      foreach (char ch in text) {
        var a = new INPUT(); var z = new INPUT();
        a.type = z.type = 1;
        if (ch == '\n') { a.ki.wVk = z.ki.wVk = 0x0D; z.ki.dwFlags = 0x0002; }
        else { a.ki.wScan = z.ki.wScan = ch; a.ki.dwFlags = 0x0004; z.ki.dwFlags = 0x0004 | 0x0002; }
        Send(a, z);
      }
    }
  }

  /** Bring a top-level window to the foreground despite the foreground lock. */
  static bool Focus(AutomationElement w) {
    var h = new IntPtr(w.Current.NativeWindowHandle);
    if (h == IntPtr.Zero) throw new UiError("bad", "that element is not a window");
    if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
    if (!SetForegroundWindow(h)) {
      // A process that sent the last input may take the foreground: press and release Alt.
      var a = new INPUT(); var z = new INPUT();
      a.type = z.type = 1; a.ki.wVk = z.ki.wVk = 0x12; z.ki.dwFlags = 0x0002;
      lock (InputLock) Send(a, z);
      SetForegroundWindow(h);
    }
    Thread.Sleep(30);
    return GetForegroundWindow() == h;
  }

  // --- the notification area ---------------------------------------------------

  /**
   * Click a notification-area icon by its tooltip (substring, case-insensitive):
   * on the taskbar if it is promoted there, else in the overflow flyout, which is
   * opened through the taskbar's "Show hidden icons" button. Then, with `menu`,
   * click that item in the context menu the click opened.
   */
  static Dictionary<string, object> Tray(Dictionary<string, object> b) {
    string tip = Str(b, "name");
    if (string.IsNullOrEmpty(tip)) throw new UiError("bad", "tray needs name: the icon's tooltip, or part of it");
    string button = Str(b, "button") ?? "right";
    string item = Str(b, "menu");
    int timeout = Int(b, "timeoutMs", 10000);
    var sw = Stopwatch.StartNew();
    bool overflow = false;
    AutomationElement icon = null, bar = null;
    Dictionary<string, object> result = null;
    for (int attempt = 1; ; attempt++) {
      int[] p = null;
      while (p == null) {
        bar = TopLevel().FirstOrDefault(w => w.Cached.ClassName == "Shell_TrayWnd");
        if (bar == null) throw new UiError("notfound", "no taskbar (Shell_TrayWnd)");
        icon = TrayIcon(bar, tip, true);
        if (icon == null) {
          var flyout = OverflowWindow();
          if (flyout == null) {
            var chevron = Chevron(bar);
            if (chevron == null) throw new UiError("notfound", "no tray icon like \"" + tip + "\" and no \"Show hidden icons\" button");
            int[] at = ClickPoint(chevron);
            Click(at[0], at[1], "left", 1);
            var until = sw.ElapsedMilliseconds + 2000;
            while ((flyout = OverflowWindow()) == null && sw.ElapsedMilliseconds < until) Thread.Sleep(30);
          }
          if (flyout != null) {
            overflow = true;
            var until = sw.ElapsedMilliseconds + 1500;
            while ((icon = TrayIcon(flyout, tip, false)) == null && sw.ElapsedMilliseconds < until) Thread.Sleep(30);
          }
        }
        if (icon != null) {
          // A flyout still closing from a previous call shows the icon, then takes it away: look again.
          Steady(icon, 1500);
          try { p = ClickPoint(icon); } catch (Exception) { icon = null; }
        }
        if (p == null) {
          if (sw.ElapsedMilliseconds >= timeout) throw new UiError("notfound", "no tray icon like \"" + tip + "\" on the taskbar or in the overflow");
          Thread.Sleep(200);
        }
      }
      Dictionary<string, object> desc;
      try { desc = Describe(icon, false); } catch (ElementNotAvailableException) { desc = Describe(icon, true); }
      Click(p[0], p[1], button == "double" ? "left" : button, button == "double" ? 2 : 1);
      result = Obj("icon", desc, "overflow", overflow, "at", p, "clickedMs", sw.ElapsedMilliseconds, "attempts", attempt);
      if (item == null) return result;
      // The menu should be up within a second or two. If not (the click came
      // while the flyout was still moving, or the app had not attached its
      // menu yet: right after start), dismiss whatever opened and click again.
      int left = timeout - (int)sw.ElapsedMilliseconds;
      try {
        var m = Menu(b, item, Math.Max(1000, Math.Min(2500, left)), Str(b, "menuAction") ?? "click");
        result["menuItem"] = m["element"];
        break;
      } catch (UiError e) {
        if (e.Code != "notfound" || sw.ElapsedMilliseconds >= timeout) throw;
        Log("tray: no \"" + item + "\" after click " + attempt + "; again");
        if (TopLevel().Any(w => w.Cached.ClassName == "#32768")) Key(0x1B); // Esc closes a wrong menu
      }
    }
    // The flyout stays open over the desktop after its icon's menu is done
    // with; close it the way a person would, with the chevron.
    if (overflow && OverflowWindow() != null) {
      var chevron = Chevron(bar);
      if (chevron != null) { int[] c = ClickPoint(chevron); Click(c[0], c[1], "left", 1); result["closedOverflow"] = true; }
    }
    return result;
  }

  static void Key(ushort vk) {
    var a = new INPUT(); var z = new INPUT();
    a.type = z.type = 1; a.ki.wVk = z.ki.wVk = vk; z.ki.dwFlags = 0x0002;
    lock (InputLock) Send(a, z);
  }


  /** On the taskbar only the notification area's buttons count: "Maximal - 1 running window" is a task button. */
  static AutomationElement TrayIcon(AutomationElement scope, string tip, bool taskbar) {
    using (Cache(TreeScope.Element).Activate()) {
      foreach (AutomationElement e in scope.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button))) {
        var i = e.Cached;
        if (taskbar && !(i.AutomationId == "SystemTrayIcon" || i.AutomationId == "NotifyItemIcon" || i.ClassName.StartsWith("SystemTray."))) continue;
        if (i.Name.IndexOf(tip, StringComparison.OrdinalIgnoreCase) < 0) continue;
        if (i.Name.IndexOf("hidden icons", StringComparison.OrdinalIgnoreCase) >= 0) continue;
        var r = i.BoundingRectangle;
        if (r.IsEmpty || r.Width <= 0) continue;
        return e;
      }
    }
    return null;
  }

  static AutomationElement Chevron(AutomationElement bar) {
    using (Cache(TreeScope.Element).Activate()) {
      foreach (AutomationElement e in bar.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button))) {
        var i = e.Cached;
        if (i.Name.IndexOf("hidden icons", StringComparison.OrdinalIgnoreCase) >= 0) return e;
      }
      // Another display language: the chevron is the tray's only NormalButton.
      foreach (AutomationElement e in bar.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ClassNameProperty, "SystemTray.NormalButton")))
        return e;
    }
    return null;
  }

  static AutomationElement OverflowWindow() {
    foreach (var w in TopLevel()) {
      var i = w.Cached;
      if (i.ClassName == "TopLevelWindowForOverflowXamlIsland" || i.ClassName == "NotifyIconOverflowWindow") {
        var r = i.BoundingRectangle;
        if (!r.IsEmpty && r.Width > 0 && !i.IsOffscreen) return w;
      }
    }
    return null;
  }

  static string MenuText(string s) {
    int tab = s.IndexOf('\t');
    if (tab >= 0) s = s.Substring(0, tab);
    return s.Replace("&", "").Trim().TrimEnd('\u2026', '.').Trim();
  }

  /** Wait (briefly) until an element stops moving: a flyout or menu that is still sliding in. */
  static void Steady(AutomationElement e, int maxMs) {
    var sw = Stopwatch.StartNew();
    System.Windows.Rect last = System.Windows.Rect.Empty;
    int same = 0;
    while (sw.ElapsedMilliseconds < maxMs) {
      System.Windows.Rect r;
      try { r = e.Current.BoundingRectangle; } catch (ElementNotAvailableException) { return; }
      if (r == last && !r.IsEmpty) { if (++same >= 2) return; } else same = 0;
      last = r;
      Thread.Sleep(30);
    }
  }

  /**
   * Click (or invoke) an item of an open context menu: a Win32 popup (#32768)
   * or any top-level Menu. Matched on its text without accelerators, exact
   * first, then as a prefix, case-insensitive.
   */
  static Dictionary<string, object> Menu(Dictionary<string, object> b, string name, int timeoutMs, string action) {
    if (string.IsNullOrEmpty(name)) throw new UiError("bad", "menu needs name: the item's text");
    string want = MenuText(name);
    var sw = Stopwatch.StartNew();
    while (true) {
      AutomationElement hit = null, prefix = null;
      try {
        foreach (var w in TopLevel()) {
          var wi = w.Cached;
          if (wi.ClassName != "#32768" && wi.ControlType != ControlType.Menu) continue;
          using (Cache(TreeScope.Element).Activate()) {
            foreach (AutomationElement e in w.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem))) {
              string t = MenuText(e.Cached.Name);
              if (string.Equals(t, want, StringComparison.OrdinalIgnoreCase)) { hit = e; break; }
              if (prefix == null && t.StartsWith(want, StringComparison.OrdinalIgnoreCase)) prefix = e;
            }
          }
          if (hit != null) break;
        }
      } catch (ElementNotAvailableException) { }
      hit = hit ?? prefix;
      if (hit != null) {
        Steady(hit, 1000);
        var desc = Describe(hit, false);
        if (action == "invoke") {
          object pat;
          if (!hit.TryGetCurrentPattern(InvokePattern.Pattern, out pat)) throw new UiError("bad", "the menu item has no Invoke pattern");
          ((InvokePattern)pat).Invoke();
        } else {
          int[] at = ClickPoint(hit);
          Click(at[0], at[1], "left", 1);
        }
        return Obj("element", desc, "waitedMs", sw.ElapsedMilliseconds);
      }
      if (sw.ElapsedMilliseconds >= timeoutMs) throw new UiError("notfound", "no open menu with an item \"" + name + "\"");
      Thread.Sleep(30);
    }
  }
}
