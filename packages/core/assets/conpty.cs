// conpty: one terminal session for the in-guest agent's GET /term. Starts a
// shell in a pseudo-console (ConPTY) and relays it over a loopback TCP
// connection to the agent's HTTP server, which carries it on to a WebSocket.
//
//   conpty.exe --port <p> --key <k> [--cols N] [--rows N] [--cwd DIR] -- <exe> [args...]
//
// It CONNECTS to 127.0.0.1:<p> (the agent listens; nothing listens here) and
// says who it is with the session's one-time key. Then frames both ways, each
// [type: 1 byte][length: uint32 LE][payload]:
//
//   agent -> conpty   'i' keystrokes, raw     'r' resize: cols, rows (uint16 LE each)
//   conpty -> agent   'H' the key (first)     'o' shell output, raw
//                     'x' exit code (int32 LE), then it closes
//                     'e' an error message (UTF-8), then it closes
//
// Why a socket and not stdio: the agent's spawner starts this through
// runinsession.exe, which gives it a console of its own and no inherited
// handles, so it cannot hold the agent's listening socket. And the HTTP server
// that owns the WebSocket must not spawn anything itself (see guestagent.ts).
//
// No orphans: the shell and everything it starts sit in a kill-on-close job
// object that only this process holds. When the connection ends (the WebSocket
// closed, or the agent died) this process ends, and the job takes the tree with
// it. Compiled in the guest by agent-install.ps1 with Add-Type (C# 5). A change
// here needs AGENT_VERSION bumped in guestagent.ts, so installs pick it up.
using System;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class ConPty {
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO { public int cb; public string r, desk, title; public int x, y, xs, ys, xc, yc, fill, flags; public short show, r2; public IntPtr r3, i, o, e; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO si; public IntPtr attrs; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hp, ht; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", SetLastError = true)] static extern int CreatePseudoConsole(COORD size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr hpc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int ResizePseudoConsole(IntPtr hpc, COORD size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern void ClosePseudoConsole(IntPtr hpc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out SafeFileHandle r, out SafeFileHandle w, IntPtr sa, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000, CREATE_SUSPENDED = 0x00000004;
  const int STARTF_USESTDHANDLES = 0x00000100;
  const uint PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

  static TcpClient tcp;
  static NetworkStream net;
  static readonly object SendLock = new object();
  static IntPtr job = IntPtr.Zero;

  static void Send(byte type, byte[] data, int n) {
    var head = new byte[5];
    head[0] = type;
    BitConverter.GetBytes(n).CopyTo(head, 1);
    lock (SendLock) {
      net.Write(head, 0, 5);
      if (n > 0) net.Write(data, 0, n);
    }
  }

  static void ReadFull(Stream s, byte[] buf, int n) {
    for (int off = 0; off < n; ) {
      int k = s.Read(buf, off, n - off);
      if (k <= 0) throw new EndOfStreamException();
      off += k;
    }
  }

  // MSVCRT quoting, which is what a program's argv parser undoes.
  static string Q(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
    var sb = new StringBuilder("\"");
    int bs = 0;
    foreach (char c in a) {
      if (c == '\\') { bs++; continue; }
      if (c == '"') { sb.Append('\\', bs * 2 + 1); bs = 0; sb.Append('"'); continue; }
      sb.Append('\\', bs); bs = 0; sb.Append(c);
    }
    sb.Append('\\', bs * 2).Append('"');
    return sb.ToString();
  }

  static short Clamp(int v) { return (short)Math.Max(1, Math.Min(1000, v)); }
  static short Dim(string s, short dflt) {
    int v;
    return s != null && int.TryParse(s, out v) ? Clamp(v) : dflt;
  }

  /** Kill the shell's whole tree and leave. Closing the job handle at exit would too; this does not wait for it. */
  static void Die(int code) {
    if (job != IntPtr.Zero) TerminateJobObject(job, 1);
    Environment.Exit(code);
  }

  static int Main(string[] argv) {
    string port = null, key = null, cols = null, rows = null, cwd = null;
    int i = 0;
    for (; i < argv.Length; i++) {
      if (argv[i] == "--") { i++; break; }
      if (i + 1 >= argv.Length) break;
      switch (argv[i]) {
        case "--port": port = argv[++i]; break;
        case "--key": key = argv[++i]; break;
        case "--cols": cols = argv[++i]; break;
        case "--rows": rows = argv[++i]; break;
        case "--cwd": cwd = argv[++i]; break;
        default: Console.Error.WriteLine("unknown option " + argv[i]); return 1;
      }
    }
    if (port == null || key == null || i >= argv.Length) {
      Console.Error.WriteLine("usage: conpty --port <p> --key <k> [--cols N] [--rows N] [--cwd DIR] -- <exe> [args...]");
      return 1;
    }
    tcp = new TcpClient();
    tcp.NoDelay = true;
    try { tcp.Connect("127.0.0.1", int.Parse(port)); } catch (Exception e) { Console.Error.WriteLine("connect: " + e.Message); return 2; }
    net = tcp.GetStream();
    var k = Encoding.UTF8.GetBytes(key);
    Send((byte)'H', k, k.Length);

    try {
      return Run(argv, i, cwd, new COORD { X = Dim(cols, 80), Y = Dim(rows, 24) });
    } catch (Exception e) {
      try { var m = Encoding.UTF8.GetBytes(e.Message); Send((byte)'e', m, m.Length); } catch { }
      Die(3);
      return 3;
    }
  }

  static int Run(string[] argv, int first, string cwd, COORD size) {
    SafeFileHandle inRead, inWrite, outRead, outWrite;
    if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0) || !CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0))
      throw new Exception("CreatePipe failed: " + Marshal.GetLastWin32Error());
    IntPtr hpc;
    int hr = CreatePseudoConsole(size, inRead, outWrite, 0, out hpc);
    if (hr != 0) throw new Exception("CreatePseudoConsole failed: 0x" + hr.ToString("x8"));

    IntPtr attrSize = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
    IntPtr attrs = Marshal.AllocHGlobal(attrSize);
    if (!InitializeProcThreadAttributeList(attrs, 1, 0, ref attrSize)) throw new Exception("InitializeProcThreadAttributeList: " + Marshal.GetLastWin32Error());
    if (!UpdateProcThreadAttribute(attrs, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpc, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
      throw new Exception("UpdateProcThreadAttribute: " + Marshal.GetLastWin32Error());

    var si = new STARTUPINFOEX();
    si.si.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
    si.attrs = attrs;
    // Explicitly no standard handles: otherwise a shell can end up writing to
    // this process's own stdout instead of the pseudo-console.
    si.si.flags = STARTF_USESTDHANDLES;
    si.si.i = si.si.o = si.si.e = new IntPtr(-1);

    var cmd = new StringBuilder();
    for (int k = first; k < argv.Length; k++) { if (k > first) cmd.Append(' '); cmd.Append(Q(argv[k])); }
    if (string.IsNullOrEmpty(cwd)) cwd = Environment.GetEnvironmentVariable("USERPROFILE");
    if (!string.IsNullOrEmpty(cwd) && !Directory.Exists(cwd)) throw new Exception("no such directory: " + cwd);

    job = CreateJobObject(IntPtr.Zero, null);
    var lim = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    lim.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (job == IntPtr.Zero || !SetInformationJobObject(job, 9 /* JobObjectExtendedLimitInformation */, ref lim, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
      throw new Exception("job object: " + Marshal.GetLastWin32Error());

    PROCESS_INFORMATION pi;
    if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED, IntPtr.Zero, cwd, ref si, out pi))
      throw new Exception("could not start " + argv[first] + ": error " + Marshal.GetLastWin32Error());
    // In the job before it runs a single instruction, so nothing it starts escapes.
    if (!AssignProcessToJobObject(job, pi.hp)) { int err = Marshal.GetLastWin32Error(); TerminateJobObject(job, 1); throw new Exception("AssignProcessToJobObject: " + err); }
    ResumeThread(pi.ht);
    CloseHandle(pi.ht);
    // The pseudo-console holds its own copies now.
    inRead.Dispose();
    outWrite.Dispose();

    // Shell output -> the agent. Ends at EOF, which comes once the pseudo-console is closed.
    var output = new Thread(delegate () {
      var buf = new byte[16384];
      try {
        using (var s = new FileStream(outRead, FileAccess.Read, 1)) {
          for (int n; (n = s.Read(buf, 0, buf.Length)) > 0; ) Send((byte)'o', buf, n);
        }
      } catch { }
    });
    output.IsBackground = true;
    output.Start();

    // The agent -> keystrokes and resizes. The connection ending ends everything.
    var input = new Thread(delegate () {
      try {
        using (var w = new FileStream(inWrite, FileAccess.Write, 1)) {
          var head = new byte[5];
          var body = new byte[65536];
          for (;;) {
            ReadFull(net, head, 5);
            int n = BitConverter.ToInt32(head, 1);
            if (n < 0 || n > body.Length) throw new InvalidDataException("frame too large");
            ReadFull(net, body, n);
            if (head[0] == 'i') { w.Write(body, 0, n); w.Flush(); }
            else if (head[0] == 'r' && n >= 4) {
              ResizePseudoConsole(hpc, new COORD { X = Clamp(BitConverter.ToUInt16(body, 0)), Y = Clamp(BitConverter.ToUInt16(body, 2)) });
            }
          }
        }
      } catch { }
      Die(0);
    });
    input.IsBackground = true;
    input.Start();

    WaitForSingleObject(pi.hp, 0xFFFFFFFF);
    uint code;
    GetExitCodeProcess(pi.hp, out code);
    CloseHandle(pi.hp);
    // What the shell printed last is still in the pseudo-console: closing it
    // flushes that and ends the output pipe. On older Windows ClosePseudoConsole
    // blocks until the output is read, which the output thread is doing.
    var closer = new Thread(delegate () { ClosePseudoConsole(hpc); });
    closer.IsBackground = true;
    closer.Start();
    output.Join(3000);
    TerminateJobObject(job, (uint)code);
    Send((byte)'x', BitConverter.GetBytes((int)code), 4);
    try { net.Flush(); tcp.Client.Shutdown(SocketShutdown.Send); } catch { }
    Thread.Sleep(100);
    Environment.Exit(0);
    return 0;
  }
}
