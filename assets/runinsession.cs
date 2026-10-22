// Start a program on the interactive desktop of the active console session,
// from session 0 (qemu-ga runs as SYSTEM there, where nothing it starts can
// show a window). Compiled in the guest by agent-install.ps1 via Add-Type.
//
//   runinsession.exe [--wait] [--hidden] <exe> [args...]
//
//   --wait    wait for it and exit with its exit code
//   --hidden  no console window (CREATE_NO_WINDOW) instead of a new visible one
//
// Prints "session <id> pid <pid>". Exit 2-4: no user token / no logon / spawn failed.
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
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint c);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

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

    static int Main(string[] argv) {
        int i = 0; bool wait = false, hidden = false;
        for (; i < argv.Length; i++) {
            if (argv[i] == "--wait") wait = true;
            else if (argv[i] == "--hidden") hidden = true;
            else break;
        }
        if (i >= argv.Length) { Console.Error.WriteLine("usage: runinsession [--wait] [--hidden] <exe> [args...]"); return 1; }
        uint sid = WTSGetActiveConsoleSessionId();
        IntPtr ut, pt, env;
        if (!WTSQueryUserToken(sid, out ut)) { Console.Error.WriteLine("WTSQueryUserToken " + Marshal.GetLastWin32Error()); return 2; }
        if (!DuplicateTokenEx(ut, 0x02000000, IntPtr.Zero, 2, 1, out pt)) { Console.Error.WriteLine("DuplicateTokenEx " + Marshal.GetLastWin32Error()); return 3; }
        CreateEnvironmentBlock(out env, pt, false);
        var cmd = new StringBuilder();
        for (int k = i; k < argv.Length; k++) { if (k > i) cmd.Append(' '); cmd.Append(Q(argv[k])); }
        var si = new SI(); si.cb = Marshal.SizeOf(si); si.desk = "winsta0\\default";
        PI pi;
        uint flags = 0x00000400 /* UNICODE_ENVIRONMENT */ | (hidden ? 0x08000000u /* CREATE_NO_WINDOW */ : 0x00000010u /* CREATE_NEW_CONSOLE */);
        if (!CreateProcessAsUser(pt, null, cmd, IntPtr.Zero, IntPtr.Zero, false, flags, env, null, ref si, out pi)) {
            Console.Error.WriteLine("CreateProcessAsUser " + Marshal.GetLastWin32Error()); return 4;
        }
        Console.WriteLine("session " + sid + " pid " + pi.pid);
        CloseHandle(ut); CloseHandle(pt);
        int code = 0;
        if (wait) { WaitForSingleObject(pi.hp, 0xFFFFFFFF); uint c; GetExitCodeProcess(pi.hp, out c); code = (int)c; }
        CloseHandle(pi.ht); CloseHandle(pi.hp);
        return code;
    }
}
