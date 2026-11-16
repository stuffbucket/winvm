using System;
using System.Runtime.InteropServices;
using System.Text;

class RunInSession {
    [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSQueryUserToken(uint s, out IntPtr t);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr h, uint acc, IntPtr sa, int imp, int type, out IntPtr n);
    [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr tok, bool inherit);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SI { public int cb; public string r, desk, title; public int x, y, xs, ys, xc, yc, fill, flags; public short show, r2; public IntPtr r3, i, o, e; }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr hp, ht; public int pid, tid; }
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(IntPtr tok, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
    [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid, out uint s);
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint c);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

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

    static int Main(string[] argv) {
        int i = 0; bool wait = false, hidden = false, self = false;
        for (; i < argv.Length; i++) {
            if (argv[i] == "--wait") wait = true;
            else if (argv[i] == "--hidden") hidden = true;
            else if (argv[i] == "--self") self = true;
            else break;
        }
        if (i >= argv.Length) { Console.Error.WriteLine("usage: runinsession [--wait] [--hidden] [--self] <exe> [args...]"); return 1; }
        var cmd = new StringBuilder();
        for (int k = i; k < argv.Length; k++) { if (k > i) cmd.Append(' '); cmd.Append(Q(argv[k])); }
        var si = new SI(); si.cb = Marshal.SizeOf(si);
        PI pi;
        uint window = hidden ? 0x08000000u : 0x00000010u;
        uint sid;
        if (self) {
            if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false, window, IntPtr.Zero, null, ref si, out pi)) {
                Console.Error.WriteLine("CreateProcess " + Marshal.GetLastWin32Error()); return 4;
            }
            ProcessIdToSessionId(GetCurrentProcessId(), out sid);
        } else {
            sid = WTSGetActiveConsoleSessionId();
            IntPtr ut, pt, env;
            if (!WTSQueryUserToken(sid, out ut)) { Console.Error.WriteLine("WTSQueryUserToken " + Marshal.GetLastWin32Error()); return 2; }
            if (!DuplicateTokenEx(ut, 0x02000000, IntPtr.Zero, 2, 1, out pt)) { Console.Error.WriteLine("DuplicateTokenEx " + Marshal.GetLastWin32Error()); return 3; }
            CreateEnvironmentBlock(out env, pt, false);
            si.desk = "winsta0\\default";
            uint flags = 0x00000400 | window;
            if (!CreateProcessAsUser(pt, null, cmd, IntPtr.Zero, IntPtr.Zero, false, flags, env, null, ref si, out pi)) {
                Console.Error.WriteLine("CreateProcessAsUser " + Marshal.GetLastWin32Error()); return 4;
            }
            CloseHandle(ut); CloseHandle(pt);
        }
        Console.WriteLine("session " + sid + " pid " + pi.pid);
        int code = 0;
        if (wait) { WaitForSingleObject(pi.hp, 0xFFFFFFFF); uint c; GetExitCodeProcess(pi.hp, out c); code = (int)c; }
        CloseHandle(pi.ht); CloseHandle(pi.hp);
        return code;
    }
}
